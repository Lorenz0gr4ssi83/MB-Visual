"""Recupero dei file danneggiati e riconoscimento dei file sconosciuti (API recover, ui/js/viewers/recover.js).

- `check`: controllo veloce all'apertura (coda dei PDF, indice degli ZIP, fine delle immagini, atomi MP4, intestazione
  SQLite/DWG/MSG). Se dice "danneggiato" l'interfaccia mostra subito la schermata di recupero.
- `identify`: firme magiche di molte famiglie (documenti, immagini, audio/video, archivi, CAD/3D, database,
  programmi, certificati...) con l'estensione da proporre ("Sembra un file X: aprilo come X").
- `recover` (lavoro in background): copia riparata in TEMP_DIR/recupero/<chiave>/ per PDF, ZIP/Office/OpenDocument,
  immagini troncate, audio/video (FFmpeg tollerante), SQLite (.recover), email .eml/.msg, DWG (anteprima incorporata e
  copie .bak/.sv$ vicine; il disegno lo rilegge l'interfaccia con libredwg).
- `carve`: file incorporati (JPEG, PNG, GIF, BMP, PDF, ZIP, RIFF, GZIP, 7z, SQLite, RTF) ritagliati dal contenuto.
- `save`: copia del recuperato dove vuole l'utente; MAI sopra l'originale.
L'originale non si modifica mai: si legge soltanto.
"""
from __future__ import annotations

import email
import email.policy
import hashlib
import os
import re
import shutil
import struct
import subprocess
import zlib
from email.message import EmailMessage
from pathlib import Path

from .i18n import t
from .paths import NO_WINDOW, TEMP_DIR

ROOT = TEMP_DIR / "recupero"
MAX_READ = 1024 ** 3  # oltre 1 GB il carving legge solo il primo GB


def _key(path: str) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:16]


def _outdir(path: str, sub: str = "") -> Path:
    d = ROOT / _key(path) / sub if sub else ROOT / _key(path)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _note(key, *args):
    return t(key, *args)


# ---------------------------------------------------------------- riconoscimento dal contenuto
# (offset, firma, estensione proposta, gruppo, nome del formato). Il gruppo da' la parola tradotta
# (documento, immagine, ...): srv_recover.g_<gruppo>.
SIGS = [
    (0, b"%PDF-", "pdf", "doc", "PDF"),
    (0, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "ole", "doc", "Office 97-2003 / OLE"),
    (0, b"PK\x03\x04", "zip", "zip", "ZIP"),
    (0, b"PK\x05\x06", "zip", "zip", "ZIP"),
    (0, b"{\\rtf", "rtf", "doc", "RTF"),
    (0, b"%!PS", "ps", "doc", "PostScript"),
    (0, b"\xc5\xd0\xd3\xc6", "eps", "doc", "EPS"),
    (0, b"AT&TFORM", "djvu", "doc", "DjVu"),
    (0, b"ITSF", "chm", "doc", "CHM"),
    (60, b"BOOKMOBI", "mobi", "doc", "MOBI"),
    (0, b"\x89PNG\r\n\x1a\n", "png", "img", "PNG"),
    (0, b"\xff\xd8\xff", "jpg", "img", "JPEG"),
    (0, b"GIF87a", "gif", "img", "GIF"),
    (0, b"GIF89a", "gif", "img", "GIF"),
    (0, b"II*\x00", "tif", "img", "TIFF"),
    (0, b"MM\x00*", "tif", "img", "TIFF"),
    (0, b"8BPS", "psd", "img", "Photoshop PSD"),
    (0, b"\x00\x00\x01\x00", "ico", "img", "ICO"),
    (0, b"\x00\x00\x00\x0cjP  ", "jp2", "img", "JPEG 2000"),
    (0, b"\xff\x4f\xff\x51", "j2k", "img", "JPEG 2000"),
    (0, b"v/1\x01", "exr", "img", "OpenEXR"),
    (0, b"DDS ", "dds", "img", "DDS"),
    (0, b"qoif", "qoi", "img", "QOI"),
    (0, b"gimp xcf", "xcf", "img", "GIMP XCF"),
    (128, b"DICM", "dcm", "img", "DICOM"),
    (0, b"#?RADIANCE", "hdr", "img", "Radiance HDR"),
    (0, b"\x1aE\xdf\xa3", "mkv", "av", "Matroska / WebM"),
    (0, b"OggS", "ogg", "av", "Ogg"),
    (0, b"fLaC", "flac", "av", "FLAC"),
    (0, b"ID3", "mp3", "av", "MP3"),
    (0, b"\x00\x00\x01\xba", "mpg", "av", "MPEG-PS"),
    (0, b"\x00\x00\x01\xb3", "mpg", "av", "MPEG"),
    (0, b"0&\xb2u\x8ef\xcf\x11", "wmv", "av", "Windows Media"),
    (0, b"FLV\x01", "flv", "av", "Flash Video"),
    (0, b"MThd", "mid", "av", "MIDI"),
    (0, b"#!AMR", "amr", "av", "AMR"),
    (0, b".snd", "au", "av", "AU"),
    (0, b"7z\xbc\xaf\x27\x1c", "7z", "zip", "7-Zip"),
    (0, b"Rar!\x1a\x07", "rar", "zip", "RAR"),
    (0, b"\x1f\x8b", "gz", "zip", "GZIP"),
    (0, b"BZh", "bz2", "zip", "BZIP2"),
    (0, b"\xfd7zXZ\x00", "xz", "zip", "XZ"),
    (0, b"\x28\xb5\x2f\xfd", "zst", "zip", "Zstandard"),
    (0, b"\x04\x22\x4d\x18", "lz4", "zip", "LZ4"),
    (0, b"MSCF", "cab", "zip", "CAB"),
    (257, b"ustar", "tar", "zip", "TAR"),
    (0x8001, b"CD001", "iso", "zip", "ISO"),
    (0, b"xar!", "xar", "zip", "XAR"),
    (0, b"conectix", "vhd", "zip", "VHD"),
    (0, b"KDMV", "vmdk", "zip", "VMDK"),
    (0, b"SQLite format 3\x00", "sqlite", "db", "SQLite"),
    (4, b"Standard Jet DB", "mdb", "db", "Access MDB"),
    (4, b"Standard ACE DB", "accdb", "db", "Access ACCDB"),
    (0, b"PAR1", "parquet", "db", "Parquet"),
    (0, b"ARROW1", "arrow", "db", "Arrow"),
    (0, b"\x89HDF\r\n\x1a\n", "h5", "db", "HDF5"),
    (0, b"CDF\x01", "nc", "db", "NetCDF"),
    (0, b"CDF\x02", "nc", "db", "NetCDF"),
    (0, b"AC10", "dwg", "cad", "AutoCAD DWG"),
    (0, b"AC1.40", "dwg", "cad", "AutoCAD DWG"),
    (0, b"(DWF V", "dwf", "cad", "Autodesk DWF"),
    (0, b"glTF", "glb", "3d", "glTF"),
    (0, b"Kaydara FBX Binary", "fbx", "3d", "FBX"),
    (0, b"BLENDER", "blend", "3d", "Blender"),
    (0, b"U3D\x00", "u3d", "3d", "U3D"),
    (0, b"LASF", "las", "3d", "LAS"),
    (0, b"ASTM-E57", "e57", "3d", "E57"),
    (0, b"ply\n", "ply", "3d", "PLY"),
    (0, b"ply\r\n", "ply", "3d", "PLY"),
    (0, b"3D Geometry File Format", "3dm", "3d", "Rhino 3DM"),
    (0, b"\x00\x00\x27\x0a", "shp", "gis", "Shapefile"),
    (0, b"MZ", "exe", "exe", "Windows EXE/DLL"),
    (0, b"\x7fELF", "elf", "exe", "ELF"),
    (0, b"\xca\xfe\xba\xbe", "class", "exe", "Java class"),
    (0, b"\xcf\xfa\xed\xfe", "macho", "exe", "Mach-O"),
    (0, b"\x00asm", "wasm", "exe", "WebAssembly"),
    (0, b"FWS", "swf", "exe", "Flash SWF"),
    (0, b"CWS", "swf", "exe", "Flash SWF"),
    (0, b"L\x00\x00\x00\x01\x14\x02\x00", "lnk", "exe", "Windows LNK"),
    (0, b"regf", "dat", "exe", "Windows Registry"),
    (0, b"ElfFile\x00", "evtx", "exe", "Windows EVTX"),
    (0, b"\xd4\xc3\xb2\xa1", "pcap", "db", "PCAP"),
    (0, b"\x0a\x0d\x0d\x0a", "pcapng", "db", "PCAPNG"),
    (0, b"\x00\x01\x00\x00\x00", "ttf", "font", "TrueType"),
    (0, b"OTTO", "otf", "font", "OpenType"),
    (0, b"ttcf", "ttc", "font", "TrueType Collection"),
    (0, b"wOFF", "woff", "font", "WOFF"),
    (0, b"wOF2", "woff2", "font", "WOFF2"),
    (0, b"-----BEGIN CERTIFICATE", "pem", "sig", "Certificato PEM"),
    (0, b"-----BEGIN PGP", "asc", "sig", "PGP"),
    (0, b"BEGIN:VCALENDAR", "ics", "doc", "iCalendar"),
    (0, b"BEGIN:VCARD", "vcf", "doc", "vCard"),
]


def _ole_kind(path: str) -> tuple[str, str] | None:
    try:
        import olefile
        with olefile.OleFileIO(path) as o:
            names = {"/".join(e) for e in o.listdir(streams=True, storages=True)}
    except Exception:  # noqa: BLE001
        return None
    low = {n.lower() for n in names}
    for test, ext, label in (("worddocument", "doc", "Word 97-2003"), ("workbook", "xls", "Excel 97-2003"), ("book", "xls", "Excel 5"),
                             ("powerpoint document", "ppt", "PowerPoint 97-2003"), ("visiodocument", "vsd", "Visio"),
                             ("quill", "pub", "Publisher")):
        if any(n == test or n.startswith(test + "/") for n in low):
            return ext, label
    if any(n.startswith("__substg1.0_") for n in low):
        return "msg", "Outlook MSG"
    if any("rsestorage" in n for n in low):
        return "ipt", "Autodesk Inventor"
    if "basicfileinfo" in low:
        return "rvt", "Revit"
    return "ole", "OLE"


def _zip_kind(path: str) -> tuple[str, str]:
    from . import recover_zip
    with open(path, "rb") as f:
        data = f.read(min(os.path.getsize(path), 64 * 1024 * 1024))
    names: set[str] = set()
    pos = data.find(b"PK\x03\x04")
    mime = b""
    while pos >= 0 and len(names) < 2000:
        try:
            nlen, xlen = struct.unpack("<HH", data[pos + 26:pos + 30])
        except struct.error:
            break
        n = data[pos + 30:pos + 30 + nlen].decode("utf-8", "replace")
        names.add(n)
        if n == "mimetype":
            mime = data[pos + 30 + nlen + xlen:pos + 30 + nlen + xlen + 80]
        pos = data.find(b"PK\x03\x04", pos + 30)
    k = recover_zip.kind_of(names, {"mimetype": {"data": mime}} if mime else {})
    labels = {"docx": "Word (docx)", "xlsx": "Excel (xlsx)", "pptx": "PowerPoint (pptx)", "vsdx": "Visio (vsdx)", "odt": "OpenDocument Text",
              "ods": "OpenDocument Spreadsheet", "odp": "OpenDocument Presentation", "odg": "OpenDocument Drawing", "epub": "EPUB"}
    if k != "zip":
        return k, labels.get(k, k.upper())
    for test, ext, label in (("META-INF/MANIFEST.MF", "jar", "Java JAR"), ("AndroidManifest.xml", "apk", "Android APK"),
                             ("3D/3dmodel.model", "3mf", "3MF"), ("doc.kml", "kmz", "KMZ")):
        if test in names:
            return ext, label
    if any(n.lower().endswith(".shp") for n in names):
        return "zip", "ZIP (shapefile)"
    if any(n.startswith("Index/") and n.endswith(".iwa") for n in names):
        return "pages", "Apple iWork"
    return "zip", "ZIP"


def _text_kind(sample: bytes) -> tuple[str, str] | None:
    s = sample.lstrip(b"\xef\xbb\xbf \t\r\n")[:400]
    low = s.lower()
    if low.startswith(b"<svg") or (low.startswith(b"<?xml") and b"<svg" in sample[:3000].lower()):
        return "svg", "SVG"
    if low.startswith((b"<!doctype html", b"<html")):
        return "html", "HTML"
    if low.startswith(b"<?xml") or low.startswith(b"<"):
        for tag, ext, label in ((b"<kml", "kml", "KML"), (b"<gpx", "gpx", "GPX"), (b"<collada", "dae", "COLLADA"), (b"<x3d", "x3d", "X3D"),
                                (b"<rss", "xml", "RSS"), (b"<visiodocument", "vdx", "Visio XML")):
            if tag in sample[:4000].lower():
                return ext, label
        return "xml", "XML"
    if s[:1] in (b"{", b"["):
        import json
        try:
            obj = json.loads(sample.decode("utf-8"))
            if isinstance(obj, dict) and obj.get("type") in ("FeatureCollection", "Feature"):
                return "geojson", "GeoJSON"
            return "json", "JSON"
        except Exception:  # noqa: BLE001
            if b'"type"' in s and b"Feature" in s:
                return "geojson", "GeoJSON"
            return "json", "JSON"
    if b"ISO-10303-21" in s[:200]:
        return ("ifc", "IFC") if b"IFC" in sample[:4000].upper() else ("stp", "STEP")
    if re.match(rb"\s*0\s*\r?\n\s*SECTION", s, re.I):
        return "dxf", "DXF"
    if s.startswith(b"solid ") and b"facet" in sample[:2000]:
        return "stl", "STL"
    if re.match(rb"(Received|Return-Path|From|MIME-Version|Message-ID|Delivered-To|Subject|Date|X-[\w-]+):", s):
        return "eml", "Email"
    if s.startswith(b"From ") and b"\nFrom:" in sample:
        return "mbox", "mbox"
    if s.startswith((b"#!/bin/", b"#!/usr/bin/")):
        return "sh", "Script"
    if re.match(rb"(v|vn|vt|f|o|g|mtllib|usemtl) ", s) and re.search(rb"\nf \d", sample):
        return "obj", "OBJ"
    if s.startswith(b"# ") or re.search(rb"\n#{1,3} \w", sample[:3000]):
        return "md", "Markdown"
    lines = sample.splitlines()[:20]
    if len(lines) > 2:
        for sep in (b";", b",", b"\t"):
            counts = {ln.count(sep) for ln in lines[:-1] if ln.strip()}
            if len(counts) == 1 and next(iter(counts)) >= 1:
                return "csv", "CSV"
    return "txt", "Testo"


def identify(path: str) -> dict:
    """Ipotesi sul tipo reale: {guesses: [{ext, label, gruppo, descr, certezza}], testo: bool}."""
    try:
        with open(path, "rb") as f:
            head = f.read(65536)
            f.seek(0x8001)
            iso = f.read(5)
    except OSError as e:
        return {"ok": False, "errore": str(e)}
    guesses = []

    def add(ext, label, group, certainty):
        if any(g["ext"] == ext for g in guesses):
            return
        guesses.append({"ext": ext, "label": label, "gruppo": group, "certezza": certainty,
                        "descr": t("srv_recover.sembra", t("srv_recover.g_" + group), label)})

    for off, sig, ext, group, label in SIGS:
        chunk = iso if off == 0x8001 else head[off:off + len(sig)]
        if chunk == sig:
            if ext == "ole":
                k = _ole_kind(path)
                if k:
                    ext, label = k
            elif ext == "zip":
                ext, label = _zip_kind(path)
            elif ext == "exe" and head[:2] == b"MZ":
                pe = struct.unpack("<I", head[60:64])[0] if len(head) >= 64 else 0
                if not (0 < pe < len(head) - 4 and head[pe:pe + 4] == b"PE\x00\x00"):
                    continue  # "MZ" per caso
            elif ext == "ttf" and len(head) < 12:
                continue
            add(ext, label, group, "alta")
    # contenitori RIFF e ISO BMFF (sottotipo nei byte seguenti)
    if head[:4] == b"RIFF":
        sub = head[8:12]
        m = {b"WAVE": ("wav", "WAV", "av"), b"AVI ": ("avi", "AVI", "av"), b"WEBP": ("webp", "WebP", "img"), b"ACON": ("ani", "ANI", "img"),
             b"CDR": ("cdr", "CorelDRAW", "img")}
        for k, (ext, label, group) in m.items():
            if sub.startswith(k):
                add(ext, label, group, "alta")
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"heic", b"heix", b"mif1", b"msf1", b"hevc"):
            add("heic", "HEIC", "img", "alta")
        elif brand == b"avif":
            add("avif", "AVIF", "img", "alta")
        elif brand.startswith(b"crx"):
            add("cr3", "Canon CR3", "img", "alta")
        elif brand in (b"M4A ", b"M4B "):
            add("m4a", "M4A", "av", "alta")
        elif brand.startswith(b"qt"):
            add("mov", "QuickTime", "av", "alta")
        elif brand.startswith(b"3g"):
            add("3gp", "3GP", "av", "alta")
        else:
            add("mp4", "MP4", "av", "alta")
    elif head[4:8] in (b"moov", b"mdat", b"wide", b"free"):
        add("mov", "QuickTime", "av", "media")
    if head[:2] == b"BM" and len(head) > 30 and struct.unpack("<I", head[2:6])[0] >= 30 and head[6:10] == b"\x00\x00\x00\x00":
        add("bmp", "BMP", "img", "alta")
    if head[:4] == b"FORM" and head[8:12] in (b"AIFF", b"AIFC"):
        add("aiff", "AIFF", "av", "alta")
    if head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa"):
        add("mp3", "MP3", "av", "media")
    if head[:2] in (b"\xff\xf1", b"\xff\xf9"):
        add("aac", "AAC", "av", "media")
    if len(head) > 376 and head[0] == 0x47 and head[188] == 0x47 and head[376] == 0x47:
        add("ts", "MPEG-TS", "av", "alta")
    if head[:1] == b"\x30" and b"\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x07\x02" in head[:64]:
        add("p7m", "PKCS#7 / CAdES", "sig", "alta")
    elif head[:2] == b"\x30\x82" and b"\x06\x03\x55\x04" in head[:400]:
        add("cer", "X.509 DER", "sig", "media")
    if head[:1] == b"\x0a" and head[1:2] in (b"\x00", b"\x02", b"\x03", b"\x04", b"\x05") and head[2:3] == b"\x01":
        add("pcx", "PCX", "img", "bassa")
    if head[:2] in (b"P1", b"P2", b"P3", b"P4", b"P5", b"P6") and head[2:3] in (b"\n", b" ", b"\r"):
        add("ppm", "Netpbm", "img", "media")
    # firma non in testa (file con dati davanti): PDF, ZIP, JPEG... entro i primi 64 KB
    if not guesses:
        for sig, ext, group, label in ((b"%PDF-", "pdf", "doc", "PDF"), (b"PK\x03\x04", "zip", "zip", "ZIP"), (b"\x89PNG\r\n", "png", "img", "PNG"),
                                       (b"SQLite format 3", "sqlite", "db", "SQLite")):
            i = head.find(sig, 1)
            if i > 0:
                add(ext, label, group, "bassa")
                guesses[-1]["offset"] = i
                guesses[-1]["descr"] = t("srv_recover.sembra_offset", t("srv_recover.g_" + group), label, i)
    texty = False
    sample = head[:8192]
    if sample and not guesses:
        nul = sample.count(b"\x00")
        if sample[:2] in (b"\xff\xfe", b"\xfe\xff") or (nul > len(sample) * 0.3 and sample[1::2].count(b"\x00") > len(sample) * 0.4):
            try:
                dec = sample.decode("utf-16")
                ext, label = _text_kind(dec.encode("utf-8"))
                add(ext, label + " (UTF-16)", "txt", "media")
                texty = True
            except UnicodeDecodeError:
                pass
        elif nul == 0:
            bad = sum(1 for b in sample if b < 9 or 13 < b < 32)
            if bad < max(1, len(sample) * 0.01):
                ext, label = _text_kind(sample)
                add(ext, label, "txt", "alta" if ext not in ("txt",) else "media")
                texty = True
    return {"ok": True, "guesses": guesses[:6], "testo": texty, "size": os.path.getsize(path)}


# ---------------------------------------------------------------- controllo veloce all'apertura
def _tail(path: str, n: int) -> bytes:
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - n))
        return f.read()


def _head(path: str, n: int) -> bytes:
    with open(path, "rb") as f:
        return f.read(n)


ZIPLIKE = {"zip", "docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "pptx", "pptm", "potx", "ppsx", "ppsm", "odt", "ott", "ods", "ots",
           "odp", "otp", "odg", "epub", "vsdx", "vsdm", "3mf", "kmz", "ifczip"}
IMAGES = {"jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "tif", "tiff", "webp"}
MEDIA = {"mp4", "m4v", "m4a", "mov", "3gp", "mkv", "webm", "avi", "mpg", "mpeg", "ts", "mts", "m2ts", "wmv", "flv", "mp3", "wav", "ogg", "flac", "aac"}
MP4LIKE = {"mp4", "m4v", "m4a", "mov", "3gp"}


def family(path: str, ext: str = "") -> str | None:
    ext = (ext or Path(path).suffix.lstrip(".")).lower()
    if ext == "pdf":
        return "pdf"
    if ext in ZIPLIKE:
        return "zip"
    if ext in IMAGES:
        return "image"
    if ext in MEDIA:
        return "media"
    if ext in ("sqlite", "sqlite3", "db", "db3", "gpkg", "mbtiles"):
        return "sqlite"
    if ext in ("dwg", "dwt"):
        return "dwg"
    if ext in ("eml", "msg"):
        return "email"
    return None


def _mp4_problem(path: str) -> str | None:
    size = os.path.getsize(path)
    pos, top = 0, []
    with open(path, "rb") as f:
        while pos < size and len(top) < 200:
            f.seek(pos)
            h = f.read(16)
            if len(h) < 8:
                return "srv_recover.motivo_media_troncato"
            n = struct.unpack(">I", h[:4])[0]
            typ = h[4:8]
            if n == 1:
                n = struct.unpack(">Q", h[8:16])[0]
            elif n == 0:
                n = size - pos
            if n < 8 or not re.fullmatch(rb"[a-zA-Z0-9 \xa9_-]{4}", typ):
                return "srv_recover.motivo_media_struttura"
            top.append(typ)
            if pos + n > size:
                return "srv_recover.motivo_media_troncato" if b"moov" in top else "srv_recover.motivo_media_senza_moov"
            pos += n
    if b"moov" not in top:
        return "srv_recover.motivo_media_senza_moov"
    return None


def check(path: str, ext: str = "") -> dict:
    """Controllo veloce (poche letture). {danneggiato, famiglia, motivo}"""
    fam = family(path, ext)
    res = {"ok": True, "danneggiato": False, "famiglia": fam, "motivo": None}
    if not fam:
        return res
    size = os.path.getsize(path)
    reason = None
    try:
        if size == 0:
            reason = "srv_recover.motivo_vuoto"
        elif fam == "pdf":
            head = _head(path, 1024)
            tail = _tail(path, 2048)
            if b"%PDF" not in head:
                reason = "srv_recover.motivo_pdf_intestazione"
            elif b"%%EOF" not in tail:
                reason = "srv_recover.motivo_pdf_troncato"
            else:
                m = re.findall(rb"startxref\s+(\d+)", tail)
                if not m:
                    reason = "srv_recover.motivo_pdf_xref"
                else:
                    off = int(m[-1])
                    with open(path, "rb") as f:
                        f.seek(off)
                        at = f.read(40)
                    if off >= size or not (at.startswith(b"xref") or re.match(rb"\s*\d+\s+\d+\s+obj", at)):
                        reason = "srv_recover.motivo_pdf_xref"
        elif fam == "zip":
            from . import recover_zip
            reason = recover_zip.check(path)
        elif fam == "image":
            head = _head(path, 16)
            tail = _tail(path, 1024).rstrip(b"\x00")
            if head.startswith(b"\xff\xd8"):
                if b"\xff\xd9" not in tail[-64:]:
                    reason = "srv_recover.motivo_immagine_troncata"
            elif head.startswith(b"\x89PNG"):
                if b"IEND" not in tail[-32:]:
                    reason = "srv_recover.motivo_immagine_troncata"
            elif head.startswith(b"GIF8"):
                if not tail.endswith(b";"):
                    reason = "srv_recover.motivo_immagine_troncata"
            elif not identify(path).get("guesses"):
                reason = "srv_recover.motivo_intestazione"
            if not reason and size < 40 * 1024 * 1024:
                from .misc import _pil
                Image = _pil()
                try:
                    with Image.open(path) as im:
                        im.load()
                except Exception:  # noqa: BLE001
                    reason = "srv_recover.motivo_immagine_rovinata"
        elif fam == "media":
            ext2 = (ext or Path(path).suffix.lstrip(".")).lower()
            if ext2 in MP4LIKE:
                reason = _mp4_problem(path)
        elif fam == "sqlite":
            head = _head(path, 100)
            if not head.startswith(b"SQLite format 3\x00"):
                reason = "srv_recover.motivo_sqlite_intestazione"
            else:
                ps = struct.unpack(">H", head[16:18])[0]
                ps = 65536 if ps == 1 else ps
                npages = struct.unpack(">I", head[28:32])[0]
                if npages and ps * npages > size:
                    reason = "srv_recover.motivo_sqlite_troncato"
                elif size < 50 * 1024 * 1024:
                    import sqlite3
                    try:
                        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                        try:
                            r = con.execute("PRAGMA quick_check").fetchone()
                        finally:
                            con.close()
                        if not r or r[0] != "ok":
                            reason = "srv_recover.motivo_sqlite_integrita"
                    except Exception:  # noqa: BLE001
                        reason = "srv_recover.motivo_sqlite_integrita"
        elif fam == "dwg":
            head = _head(path, 6)
            if not re.fullmatch(rb"AC1(0\d\d|\.40|\.50|2\.\d)", head) and not head.startswith(b"AC10"):
                reason = "srv_recover.motivo_dwg_intestazione"
        elif fam == "email" and path.lower().endswith(".msg"):
            import olefile
            if not olefile.isOleFile(path):
                reason = "srv_recover.motivo_msg_contenitore"
            else:
                try:
                    with olefile.OleFileIO(path) as o:
                        if not any(e[-1].startswith("__substg1.0_") for e in o.listdir()):
                            reason = "srv_recover.motivo_msg_contenitore"
                except Exception:  # noqa: BLE001
                    reason = "srv_recover.motivo_msg_contenitore"
    except Exception as e:  # noqa: BLE001
        reason = None
        res["avviso"] = str(e)
    if reason:
        res.update(danneggiato=True, motivo=t(reason), codice=reason.split(".")[-1])
    return res


# ---------------------------------------------------------------- recupero per famiglia
def _result(fam: str) -> dict:
    return {"ok": True, "famiglia": fam, "esito": "nulla", "messaggi": [], "copia": None, "elementi": [], "alternative": [], "anteprima": None}


def _set_copy(res: dict, path: Path, label: str | None = None):
    res["copia"] = {"path": str(path), "nome": path.name, "ext": path.suffix.lstrip(".").lower(), "size": path.stat().st_size,
                    "etichetta": label}


def _stem(path: str) -> str:
    return Path(path).stem or "file"


def _pdf_rebuild(data: bytes) -> bytes | None:
    """PDF con xref e albero delle pagine persi: oggetti "N G obj ... endobj" letti uno per uno e ricomposti."""
    objs: dict[int, bytes] = {}
    for m in re.finditer(rb"(?<![\d])(\d{1,7})\s+(\d{1,5})\s+obj\b", data):
        num = int(m.group(1))
        start = m.end()
        end = data.find(b"endobj", start)
        nxt = re.search(rb"(?<![\d])\d{1,7}\s+\d{1,5}\s+obj\b", data[start:start + max(0, end - start) if end > 0 else len(data)])
        if end < 0 or nxt:
            continue  # oggetto troncato o senza chiusura: si salta
        body = data[start:end].strip()
        if b"stream" in body and b"endstream" not in body:
            continue
        objs[num] = body  # l'ultima definizione vince (aggiornamenti incrementali)
    if not objs:
        return None
    pages = [n for n, b in objs.items() if re.search(rb"/Type\s*/Page(?![s\w])", b)]
    if not pages:
        return None
    top = max(objs) + 1
    pages_id, cat_id = top, top + 1
    for n in pages:
        b = objs[n]
        b = re.sub(rb"/Parent\s+\d+\s+\d+\s+R", b"/Parent %d 0 R" % pages_id, b)
        if b"/Parent" not in b:
            b = b.replace(b"<<", b"<< /Parent %d 0 R" % pages_id, 1)
        objs[n] = b
    kids = b" ".join(b"%d 0 R" % n for n in sorted(pages))
    objs[pages_id] = b"<< /Type /Pages /Kids [ %s ] /Count %d >>" % (kids, len(pages))
    objs[cat_id] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offs = {}
    for n in sorted(objs):
        offs[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    size = max(objs) + 1
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for n in range(1, size):
        out += (b"%010d 00000 n \n" % offs[n]) if n in offs else b"0000000000 65535 f \n"
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, cat_id, xref)
    return bytes(out)


def _rec_pdf(path: str, res: dict, update) -> None:
    import pymupdf
    d = _outdir(path)
    out = d / f"{_stem(path)} (recuperato).pdf"
    doc, how = None, None
    try:
        doc = pymupdf.open(path)
        if doc.page_count == 0:
            doc.close()
            doc = None
        else:
            how = "mupdf"
    except Exception:  # noqa: BLE001
        doc = None
    good_pages = 0
    if doc is not None:
        # pagine che non si riescono a disegnare: contate, il resto si tiene
        for p in doc:
            try:
                p.get_text("text")
                good_pages += 1
            except Exception:  # noqa: BLE001
                pass
    update(0.4)
    if doc is None:
        data = Path(path).read_bytes()
        rebuilt = _pdf_rebuild(data)
        if rebuilt:
            tmp = d / "ricomposto.pdf"
            tmp.write_bytes(rebuilt)
            try:
                doc = pymupdf.open(tmp)
                how = "oggetti"
                good_pages = doc.page_count
            except Exception:  # noqa: BLE001
                doc = None
    if doc is None:
        res["messaggi"].append(t("srv_recover.pdf_nessuna_pagina"))
        return
    total = doc.page_count
    doc.save(out, garbage=3, deflate=True, clean=True)
    doc.close()
    _set_copy(res, out)
    res["esito"] = "riparato" if good_pages == total else "parziale"
    res["messaggi"].append(t("srv_recover.pdf_pagine", good_pages, total))
    res["messaggi"].append(t("srv_recover.pdf_metodo_mupdf") if how == "mupdf" else t("srv_recover.pdf_metodo_oggetti"))
    try:
        d2 = pymupdf.open(out)
        txt = sum(len(p.get_text("text")) for p in d2)
        d2.close()
        if txt:
            res["messaggi"].append(t("srv_recover.pdf_testo", txt))
    except Exception:  # noqa: BLE001
        pass


def _rec_zip(path: str, res: dict, update) -> None:
    from . import recover_zip
    ext = Path(path).suffix.lstrip(".").lower()
    d = _outdir(path)
    tmp = d / "ricostruito.zip"
    r = recover_zip.recover(path, str(tmp), ext)
    update(0.7)
    if not r.get("intere") and not r.get("ricostruite"):
        res["messaggi"].append(t("srv_recover.zip_nulla"))
        return
    out_ext = ext if ext and ext != "zip" else r["kind"]
    out = d / f"{_stem(path)} (recuperato).{out_ext or 'zip'}"
    tmp.replace(out)
    _set_copy(res, out)
    res["messaggi"].append(t("srv_recover.zip_voci", r["intere"], r.get("totale", 0)))
    if r["ricostruite"]:
        res["messaggi"].append(t("srv_recover.zip_ricostruite", r["ricostruite"]))
    for key, *args in r["note"]:
        res["messaggi"].append(t(key, *args))
    if r["perse"]:
        res["messaggi"].append(t("srv_recover.zip_perse", len(r["perse"]), ", ".join(r["perse"][:8]) + ("..." if len(r["perse"]) > 8 else "")))
    if not r["ok"]:
        res["messaggi"].append(t("srv_recover.zip_principale_mancante"))
        res["esito"] = "parziale"
    else:
        res["esito"] = "riparato" if not r["perse"] and not r["ricostruite"] else "parziale"
    if r["kind"] != "zip":
        res["tipo"] = r["kind"]


def _rec_image(path: str, res: dict, update) -> None:
    from PIL import ImageFile
    from .misc import _pil
    Image = _pil()
    d = _outdir(path)
    old = ImageFile.LOAD_TRUNCATED_IMAGES
    try:
        truncated = False
        try:
            ImageFile.LOAD_TRUNCATED_IMAGES = False
            im = Image.open(path)
            im.load()
        except Exception:  # noqa: BLE001
            truncated = True
            try:
                ImageFile.LOAD_TRUNCATED_IMAGES = True
                im = Image.open(path)
                im.load()
            except Exception:  # noqa: BLE001
                im = None
        if im is None:
            # intestazione rovinata: miniatura EXIF o un'altra immagine incorporata
            carved = carve(path, max_items=20, update=None)
            imgs = [x for x in carved["elementi"] if x["ext"] in ("jpg", "png", "gif", "bmp")]
            if imgs:
                best = max(imgs, key=lambda x: x["size"])
                res["messaggi"].append(t("srv_recover.img_incorporata", len(imgs)))
                res["elementi"] = imgs
                p = Path(best["path"])
                _set_copy(res, p)
                res["esito"] = "parziale"
            else:
                res["messaggi"].append(t("srv_recover.img_nulla"))
            return
        w, h = im.size
        if im.mode not in ("RGB", "RGBA", "L", "LA"):
            im = im.convert("RGBA")
        out = d / f"{_stem(path)} (recuperato).png"
        im.save(out, "PNG")
        _set_copy(res, out)
        res["anteprima"] = str(out)
        # quanta parte e' davvero leggibile: righe in fondo tutte uguali (grigio di riempimento dei JPEG troncati)
        rows_ok = h
        try:
            px = im.convert("L").resize((min(64, w), h)) if h <= 20000 and truncated else None
            if px is not None:
                data = px.tobytes()
                ww = px.size[0]
                last = data[(h - 1) * ww:h * ww]
                r = h - 1
                while r > 0 and data[r * ww:(r + 1) * ww] == last:
                    r -= 1
                if h - r > max(2, h * 0.02):
                    rows_ok = r + 1
        except Exception:  # noqa: BLE001
            pass
        res["messaggi"].append(t("srv_recover.img_dimensioni", w, h))
        if rows_ok < h:
            res["messaggi"].append(t("srv_recover.img_parte", round(rows_ok * 100 / h)))
            res["esito"] = "parziale"
        else:
            res["esito"] = "riparato"
    finally:
        ImageFile.LOAD_TRUNCATED_IMAGES = old


def _rec_media(path: str, res: dict, update) -> None:
    from .paths import find_ffmpeg
    exe = find_ffmpeg()
    if not exe:
        res["messaggi"].append(t("srv_recover.ffmpeg_mancante"))
        return
    d = _outdir(path)
    ext = Path(path).suffix.lstrip(".").lower()
    audio_only = ext in ("mp3", "wav", "ogg", "flac", "aac", "m4a")
    tol = ["-hide_banner", "-y", "-err_detect", "ignore_err", "-fflags", "+genpts+discardcorrupt+igndts",
           *(["-ignore_editlist", "1"] if ext in MP4LIKE else []), "-i", path]
    attempts = []
    if audio_only:
        attempts.append((d / f"{_stem(path)} (recuperato).{'m4a' if ext == 'm4a' else ext}", ["-map", "0:a?", "-c", "copy"]))
        attempts.append((d / f"{_stem(path)} (recuperato).mp3", ["-map", "0:a?", "-c:a", "libmp3lame", "-q:a", "2"]))
    else:
        attempts.append((d / f"{_stem(path)} (recuperato).mkv", ["-map", "0:v?", "-map", "0:a?", "-c", "copy"]))
        attempts.append((d / f"{_stem(path)} (recuperato).mp4", ["-map", "0:v?", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast",
                                                                 "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k"]))
    last_err = ""
    for i, (out, args) in enumerate(attempts):
        update(0.2 + 0.35 * i)
        try:
            r = subprocess.run([exe, *tol, *args, str(out)], capture_output=True, timeout=3600, creationflags=NO_WINDOW)
        except subprocess.TimeoutExpired:
            continue
        err = r.stderr.decode("utf-8", "replace")
        last_err = err
        if "moov atom not found" in err:
            res["messaggi"].append(t("srv_recover.media_senza_moov"))
            return
        if r.returncode == 0 and out.exists() and out.stat().st_size > 1024:
            times = re.findall(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", err)
            dur = None
            if times:
                h, m, s = times[-1]
                dur = int(h) * 3600 + int(m) * 60 + float(s)
            src_dur = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
            _set_copy(res, out)
            res["esito"] = "parziale" if ("rror" in err or "orrupt" in err or "nvalid" in err) else "riparato"
            if dur is not None:
                res["messaggi"].append(t("srv_recover.media_durata", f"{int(dur // 60)}:{dur % 60:04.1f}"))
            if src_dur:
                h, m, s = src_dur.groups()
                tot = int(h) * 3600 + int(m) * 60 + float(s)
                if dur is not None and tot > 0 and dur < tot * 0.97:
                    res["messaggi"].append(t("srv_recover.media_dichiarata", f"{int(tot // 60)}:{tot % 60:04.1f}"))
                    res["esito"] = "parziale"
            res["messaggi"].append(t("srv_recover.media_copia") if i == 0 else t("srv_recover.media_ricodificato"))
            return
    tail = " | ".join([ln for ln in last_err.splitlines() if ln.strip()][-2:])
    res["messaggi"].append(t("srv_recover.media_fallito", tail[-200:]))


def _rec_sqlite(path: str, res: dict, update) -> None:
    from . import recover_sqlite
    d = _outdir(path)
    ext = Path(path).suffix.lstrip(".").lower() or "sqlite"
    out = d / f"{_stem(path)} (recuperato).{ext}"
    r = recover_sqlite.recover(path, str(out))
    if not out.exists() or (not r["righe"] and not r["orfane"] and not r["tabelle"]):
        res["messaggi"].append(t("srv_recover.sqlite_nulla"))
        return
    _set_copy(res, out)
    res["messaggi"].append(t("srv_recover.sqlite_tabelle", len(r["tabelle"]), r["righe"]))
    for x in r["tabelle"][:12]:
        res["messaggi"].append(f"· {x['tabella']}: {x['righe']}")
    if r["orfane"]:
        res["messaggi"].append(t("srv_recover.sqlite_orfane", r["orfane"]))
    res["messaggi"].append(t("srv_recover.sqlite_metodo", r["metodo"]))
    res["esito"] = "parziale" if r["orfane"] or r["errori"] else "riparato"


def _lenient_b64(s: bytes) -> bytes:
    import base64
    s = re.sub(rb"[^A-Za-z0-9+/]", b"", s)
    s = s[:len(s) - len(s) % 4]
    try:
        return base64.b64decode(s)
    except Exception:  # noqa: BLE001
        return b""


def _rebuild_eml(path: str, res: dict, subject, sender, to, date, text, html, atts: list[tuple[str, bytes]]):
    d = _outdir(path)
    m = EmailMessage()
    for k, v in (("Subject", subject), ("From", sender), ("To", to), ("Date", date)):
        if v:
            try:
                m[k] = re.sub(r"[\r\n]+", " ", str(v))
            except Exception:  # noqa: BLE001
                pass
    m.set_content(text or (t("srv_recover.email_senza_testo") if not html else ""))
    if html:
        m.add_alternative(html, subtype="html")
    att_dir = _outdir(path, "allegati")
    for name, data in atts:
        safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "allegato")[:150] or "allegato"
        p = att_dir / safe
        p.write_bytes(data)
        res["elementi"].append({"nome": safe, "path": str(p), "size": len(data), "ext": Path(safe).suffix.lstrip(".").lower(), "tipo": "allegato"})
        import mimetypes
        mt = (mimetypes.guess_type(safe)[0] or "application/octet-stream").split("/")
        m.add_attachment(data, maintype=mt[0], subtype=mt[1], filename=safe)
    out = d / f"{_stem(path)} (recuperato).eml"
    out.write_bytes(m.as_bytes(policy=email.policy.SMTP))
    _set_copy(res, out)
    res["messaggi"].append(t("srv_recover.email_testo", len(text or "") + len(html or "")))
    res["messaggi"].append(t("srv_recover.email_allegati", len(atts)))


def _rec_eml(path: str, res: dict, update) -> None:
    raw = Path(path).read_bytes()
    msg = email.message_from_bytes(raw, policy=email.policy.compat32)
    text = html = None
    atts = []
    broken = 0
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        cte = (part.get("Content-Transfer-Encoding") or "").lower().strip()
        payload = part.get_payload(decode=False)
        if isinstance(payload, list):
            continue
        rawp = payload.encode("latin-1", "replace") if isinstance(payload, str) else (payload or b"")
        if cte == "base64":
            data = _lenient_b64(rawp)
            if len(data) * 4 // 3 < len(re.sub(rb"\s", b"", rawp)) - 8:
                broken += 1
        else:
            try:
                data = part.get_payload(decode=True) or b""
            except Exception:  # noqa: BLE001
                data = rawp
        fname = part.get_filename()
        cs = part.get_content_charset() or "utf-8"
        if fname or not ctype.startswith("text/"):
            atts.append((fname or f"allegato.{ctype.split('/')[-1]}", data))
        elif ctype == "text/html" and html is None:
            html = data.decode(cs, "replace")
        elif text is None:
            text = data.decode(cs, "replace")
    if msg.defects or broken:
        res["messaggi"].append(t("srv_recover.email_difetti", len(msg.defects) + broken))
    _rebuild_eml(path, res, msg.get("Subject"), msg.get("From"), msg.get("To"), msg.get("Date"), text, html, atts)
    res["esito"] = "parziale" if (msg.defects or broken) else "riparato"


def _rec_msg(path: str, res: dict, update) -> None:
    subject = sender = to = date = text = html = None
    atts: list[tuple[str, bytes]] = []
    ok_ole = False
    try:
        import olefile
        with olefile.OleFileIO(path) as o:
            ok_ole = True

            def get(name, prefix=""):
                for suf, enc in (("001F", "utf-16-le"), ("001E", "cp1252"), ("0102", None)):
                    p = f"{prefix}__substg1.0_{name}{suf}"
                    if o.exists(p):
                        try:
                            b = o.openstream(p).read()
                        except Exception:  # noqa: BLE001
                            return None
                        return b if enc is None else b.decode(enc, "replace").rstrip("\x00")
                return None
            subject, sender, to, text = get("0037"), get("0C1A") or get("5D01") or get("0065"), get("0E04"), get("1000")
            h = get("1013")
            if isinstance(h, bytes):
                html = h.decode("utf-8", "replace")
            elif h:
                html = h
            for e in o.listdir(streams=False, storages=True):
                if len(e) == 1 and e[0].startswith("__attach_version1.0_#"):
                    pre = e[0] + "/"
                    name = get("3707", pre) or get("3704", pre) or "allegato"
                    data = get("3701", pre)
                    if isinstance(data, bytes):
                        atts.append((str(name), data))
    except Exception:  # noqa: BLE001
        pass
    if not ok_ole or not (subject or text or html or atts):
        # contenitore illeggibile: testo UTF-16 piu' lungo come corpo e file incorporati ritagliati
        raw = Path(path).read_bytes()
        runs = [m.group().decode("utf-16-le", "replace") for m in re.finditer(rb"(?:[\x20-\x7e\xa0-\xff]\x00|[\r\n\t]\x00){12,}", raw)]
        # nomi delle voci del contenitore (directory OLE), non testo del messaggio
        runs = [r for r in runs if not re.match(r"\s*(__|Root Entry)", r)]
        runs.sort(key=len, reverse=True)
        text = "\n\n".join(runs[:5]) if runs else None
        carved = carve(path, max_items=50, update=None)
        for x in carved["elementi"]:
            atts.append((x["nome"], Path(x["path"]).read_bytes()))
        res["messaggi"].append(t("srv_recover.msg_grezzo"))
        res["esito"] = "parziale"
    else:
        res["esito"] = "riparato"
    if not (subject or text or html or atts):
        res["messaggi"].append(t("srv_recover.email_nulla"))
        res["esito"] = "nulla"
        return
    _rebuild_eml(path, res, subject, sender, to, date, text, html, atts)


DWG_SENTINEL = bytes.fromhex("1F256D07D43628289D57CA3F9D44102B")


def dwg_preview(path: str, outdir: Path) -> Path | None:
    """Anteprima salvata da AutoCAD nel DWG (indirizzo a 0x0D, BMP o PNG)."""
    from .misc import _pil
    with open(path, "rb") as f:
        data = f.read(min(os.path.getsize(path), 64 * 1024 * 1024))
    cands = []
    if len(data) > 0x11:
        cands.append(struct.unpack("<I", data[0x0D:0x11])[0])
    i = data.find(DWG_SENTINEL)
    while i >= 0 and len(cands) < 5:
        cands.append(i)
        i = data.find(DWG_SENTINEL, i + 16)
    Image = _pil()
    import io
    for addr in cands:
        if not (0 < addr < len(data) - 40) or data[addr:addr + 16] != DWG_SENTINEL:
            continue
        p = addr + 16 + 4
        count = data[p]
        p += 1
        for _ in range(min(count, 8)):
            code, start, size = data[p], *struct.unpack("<II", data[p + 1:p + 9])
            p += 9
            if not (0 < start < len(data) and 0 < size <= len(data) - start):
                continue
            blob = data[start:start + size]
            try:
                if code == 6:
                    im = Image.open(io.BytesIO(blob))
                elif code == 2:
                    hs, bits, clr = struct.unpack("<I", blob[:4])[0], struct.unpack("<H", blob[14:16])[0], struct.unpack("<I", blob[32:36])[0]
                    pal = (clr or (1 << bits if bits <= 8 else 0)) * 4
                    bmp = b"BM" + struct.pack("<IHHI", 14 + len(blob), 0, 0, 14 + hs + pal) + blob
                    im = Image.open(io.BytesIO(bmp))
                else:
                    continue
                im.load()
                out = outdir / "anteprima_dwg.png"
                im.convert("RGB").save(out)
                return out
            except Exception:  # noqa: BLE001
                continue
    return None


def dwg_alternatives(path: str) -> list[dict]:
    """Copie di sicurezza di AutoCAD vicine al disegno: <nome>.bak e i salvataggi automatici .sv$ (anche in TEMP)."""
    import tempfile
    p = Path(path)
    stem = p.stem.lower()
    found: dict[str, Path] = {}
    dirs = [p.parent, Path(tempfile.gettempdir())]
    la = os.environ.get("LOCALAPPDATA")
    if la:
        dirs.append(Path(la) / "Temp")
    for d in dirs:
        try:
            items = list(d.iterdir())
        except OSError:
            continue
        for f in items:
            n = f.name.lower()
            if not f.is_file() or f == p:
                continue
            if (d == p.parent and n in (stem + ".bak", stem + ".dwg.bak", stem + ".dwl.bak")) or \
               (n.endswith(".sv$") and (n.startswith(stem + "_") or n.startswith(stem + "."))) or \
               (d == p.parent and n.startswith(stem) and "recover" in n and n.endswith(".dwg")):
                try:
                    with open(f, "rb") as fh:
                        if not fh.read(4).startswith(b"AC1"):
                            continue
                except OSError:
                    continue
                found[str(f).lower()] = f
    out = []
    for f in sorted(found.values(), key=lambda x: x.stat().st_mtime, reverse=True):
        st = f.stat()
        out.append({"origine": str(f), "nome": f.name, "size": st.st_size, "data": st.st_mtime,
                    "tipo": "sv$" if f.name.lower().endswith(".sv$") else "bak"})
    return out


def _rec_dwg(path: str, res: dict, update) -> None:
    d = _outdir(path)
    prev = dwg_preview(path, d)
    if prev:
        res["anteprima"] = str(prev)
        res["messaggi"].append(t("srv_recover.dwg_anteprima"))
    alts = dwg_alternatives(path)
    alt_dir = _outdir(path, "copie")
    for a in alts:
        dst = alt_dir / (Path(a["nome"]).stem + " (" + a["tipo"] + ").dwg")
        shutil.copyfile(a["origine"], dst)
        a["path"] = str(dst)
        res["alternative"].append(a)
    if alts:
        res["messaggi"].append(t("srv_recover.dwg_copie", len(alts)))
    res["dwg"] = True  # il disegno lo rilegge l'interfaccia con libredwg in modo tollerante
    res["esito"] = "parziale" if prev or alts else "nulla"


RECOVERERS = {"pdf": _rec_pdf, "zip": _rec_zip, "image": _rec_image, "media": _rec_media, "sqlite": _rec_sqlite, "dwg": _rec_dwg}


def recover(path: str, update=lambda **k: None, fam: str | None = None) -> dict:
    fam = fam or family(path)
    if fam is None:
        # tipo dal contenuto (file senza estensione o con un'estensione sbagliata)
        g = [x for x in identify(path).get("guesses") or [] if x["certezza"] == "alta" and not x.get("offset")]
        fam = family(path, g[0]["ext"]) if g else None
        unknown = True
    else:
        unknown = False
    res = _result(fam or "sconosciuto")
    up = lambda p: update(progress=p)  # noqa: E731
    if fam == "email":
        (_rec_msg if Path(path).suffix.lower() == ".msg" or _head(path, 8) == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" else _rec_eml)(path, res, up)
    elif fam in RECOVERERS:
        RECOVERERS[fam](path, res, up)
    else:
        res["messaggi"].append(t("srv_recover.famiglia_sconosciuta"))
    if (res["esito"] == "nulla" or unknown) and fam not in ("dwg",):
        # nulla di strutturato: almeno i file incorporati
        c = carve(path, max_items=200, update=None)
        if c["elementi"]:
            res["elementi"] += [x for x in c["elementi"] if x not in res["elementi"]]
            res["messaggi"].append(t("srv_recover.carving_trovati", len(c["elementi"])))
    return res


# ---------------------------------------------------------------- carving (file incorporati)
def _end_jpeg(b: bytes, i: int) -> int | None:
    j = i + 2
    n = len(b)
    while j + 4 <= n:
        if b[j] != 0xFF:
            return None
        m = b[j + 1]
        if m == 0xD9:
            return j + 2
        if m in (0x01,) or 0xD0 <= m <= 0xD7:
            j += 2
            continue
        ln = struct.unpack(">H", b[j + 2:j + 4])[0]
        j += 2 + ln
        if m == 0xDA:  # dati compressi: fino al marcatore EOI
            while j + 1 < n:
                k = b.find(b"\xff", j)
                if k < 0 or k + 1 >= n:
                    return None
                nx = b[k + 1]
                if nx == 0x00 or 0xD0 <= nx <= 0xD7 or nx == 0xFF:
                    j = k + 1 if nx == 0xFF else k + 2
                    continue
                j = k
                break
    return None


def _end_png(b: bytes, i: int) -> int | None:
    j = i + 8
    while j + 12 <= len(b):
        ln = struct.unpack(">I", b[j:j + 4])[0]
        typ = b[j + 4:j + 8]
        if ln > 0x7FFFFFFF or not typ.isalpha():
            return None
        j += 12 + ln
        if typ == b"IEND":
            return j if j <= len(b) else None
    return None


def _end_gif(b: bytes, i: int) -> int | None:
    j = i + 13
    if len(b) < j:
        return None
    flags = b[i + 10]
    if flags & 0x80:
        j += 3 * (2 << (flags & 7))

    def subblocks(k):
        while k < len(b):
            s = b[k]
            k += 1
            if s == 0:
                return k
            k += s
        return None
    while j < len(b):
        c = b[j]
        if c == 0x3B:
            return j + 1
        if c == 0x21:
            j = subblocks(j + 2)
        elif c == 0x2C:
            if j + 10 > len(b):
                return None
            f2 = b[j + 9]
            j += 10
            if f2 & 0x80:
                j += 3 * (2 << (f2 & 7))
            j = subblocks(j + 1)
        else:
            return None
        if j is None:
            return None
    return None


def _end_pdf(b: bytes, i: int) -> int | None:
    nxt = b.find(b"%PDF-", i + 5)
    lim = nxt if nxt > 0 else len(b)
    k = b.rfind(b"%%EOF", i, lim)
    return k + 5 if k > 0 else None


def _end_zip(b: bytes, i: int) -> int | None:
    k = b.find(b"PK\x05\x06", i)
    if k < 0 or k + 22 > len(b):
        return None
    return k + 22 + struct.unpack("<H", b[k + 20:k + 22])[0]


def _end_bmp(b: bytes, i: int) -> int | None:
    n = struct.unpack("<I", b[i + 2:i + 6])[0]
    off = struct.unpack("<I", b[i + 10:i + 14])[0]
    hs = struct.unpack("<I", b[i + 14:i + 18])[0] if i + 18 <= len(b) else 0
    if b[i + 6:i + 10] != b"\x00\x00\x00\x00" or hs not in (12, 40, 52, 56, 108, 124) or not (54 <= off < n) or n > 512 * 1024 * 1024:
        return None
    return i + n if i + n <= len(b) else None


def _end_riff(b: bytes, i: int) -> int | None:
    n = struct.unpack("<I", b[i + 4:i + 8])[0]
    if b[i + 8:i + 12] not in (b"WAVE", b"AVI ", b"WEBP"):
        return None
    return i + 8 + n if i + 8 + n <= len(b) else None


def _end_gzip(b: bytes, i: int) -> int | None:
    if b[i + 2] != 8:
        return None
    d = zlib.decompressobj(31)
    try:
        d.decompress(b[i:i + 64 * 1024 * 1024])
    except zlib.error:
        return None
    if not d.eof:
        return None
    return i + min(len(b) - i, 64 * 1024 * 1024) - len(d.unused_data)


def _end_7z(b: bytes, i: int) -> int | None:
    off, size = struct.unpack("<QQ", b[i + 12:i + 28])
    end = i + 32 + off + size
    return end if end <= len(b) else None


def _end_sqlite(b: bytes, i: int) -> int | None:
    ps = struct.unpack(">H", b[i + 16:i + 18])[0]
    ps = 65536 if ps == 1 else ps
    n = struct.unpack(">I", b[i + 28:i + 32])[0]
    end = i + ps * n
    return end if n and end <= len(b) else None


def _end_rtf(b: bytes, i: int) -> int | None:
    depth, j = 0, i
    lim = min(len(b), i + 200 * 1024 * 1024)
    while j < lim:
        c = b[j]
        if c == 0x5C:
            j += 2
            continue
        if c == 0x7B:
            depth += 1
        elif c == 0x7D:
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return None


CARVE = [
    (b"\xff\xd8\xff", "jpg", _end_jpeg, 400),
    (b"\x89PNG\r\n\x1a\n", "png", _end_png, 60),
    (b"GIF89a", "gif", _end_gif, 40),
    (b"GIF87a", "gif", _end_gif, 40),
    (b"%PDF-", "pdf", _end_pdf, 200),
    (b"PK\x03\x04", "zip", _end_zip, 100),
    (b"BM", "bmp", _end_bmp, 60),
    (b"RIFF", "riff", _end_riff, 44),
    (b"\x1f\x8b\x08", "gz", _end_gzip, 20),
    (b"7z\xbc\xaf\x27\x1c", "7z", _end_7z, 32),
    (b"SQLite format 3\x00", "sqlite", _end_sqlite, 512),
    (b"{\\rtf", "rtf", _end_rtf, 20),
]


def carve(path: str, max_items: int = 500, update=None) -> dict:
    """Ritaglia i file incorporati riconoscibili. Ritorna {elementi: [{nome, path, size, ext, offset}], letti}."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        b = f.read(min(size, MAX_READ))
    d = _outdir(path, "estratti")
    found = []
    taken: list[tuple[int, int]] = []  # intervalli gia' estratti (niente immagini dentro uno ZIP gia' preso)
    total = len(CARVE)
    for k, (sig, ext, ender, minsize) in enumerate(CARVE):
        if update:
            update(progress=k / total)
        i = b.find(sig)
        while i >= 0 and len(found) < max_items:
            inside = any(a <= i < z for a, z in taken)
            end = None if inside else ender(b, i)
            if end and end - i >= minsize and not (i == 0 and end >= len(b) and size == len(b)):
                e2 = ext
                if ext == "riff":
                    e2 = {b"WAVE": "wav", b"AVI ": "avi", b"WEBP": "webp"}[b[i + 8:i + 12]]
                elif ext == "zip":
                    from . import recover_zip
                    names = {e["name"] for e in recover_zip.scan_entries(b[i:end])[:200]}
                    e2 = recover_zip.kind_of(names, {})
                name = f"{len(found) + 1:03d}_0x{i:X}.{e2}"
                out = d / name
                out.write_bytes(b[i:end])
                found.append({"nome": name, "path": str(out), "size": end - i, "ext": e2, "offset": i, "tipo": "incorporato"})
                taken.append((i, end))
                i = b.find(sig, end)
            else:
                i = b.find(sig, i + 1)
    found.sort(key=lambda x: x["offset"])
    return {"ok": True, "elementi": found, "letti": len(b), "troncato": len(b) < size}


def extract_text(path: str) -> dict:
    """Testo leggibile del file (ASCII/Latin-1, UTF-8 e UTF-16) in un .txt da aprire nell'editor."""
    from .misc import strings
    lines = strings(path, min_len=4, limit=200000)
    d = _outdir(path)
    out = d / f"{_stem(path)} (testo).txt"
    out.write_text("\n".join(lines), encoding="utf-8")
    return {"ok": True, "path": str(out), "righe": len(lines), "size": out.stat().st_size}


# ---------------------------------------------------------------- copie
def _inside_recovery(p: str) -> bool:
    try:
        Path(p).resolve().relative_to(ROOT.resolve())
        return True
    except ValueError:
        return False


def save_copy(src: str, out: str, original: str | None = None) -> dict:
    """Copia il recuperato dove sceglie l'utente. L'originale non si sovrascrive mai."""
    if not _inside_recovery(src):
        raise RuntimeError(t("srv_recover.sorgente_non_valida"))
    o = os.path.normcase(os.path.abspath(out))
    if original and o == os.path.normcase(os.path.abspath(original)):
        raise RuntimeError(t("srv_recover.mai_sopra_originale"))
    if o == os.path.normcase(os.path.abspath(src)):
        return {"ok": True, "path": out}
    shutil.copyfile(src, out)
    return {"ok": True, "path": out}


def as_ext(path: str, ext: str) -> dict:
    """Copia del file con l'estensione giusta ("aprilo come X"), in TEMP: l'originale resta com'e'."""
    ext = re.sub(r"[^a-z0-9]", "", (ext or "").lower())[:10]
    if not ext:
        raise RuntimeError(t("srv_recover.estensione_non_valida"))
    d = _outdir(path, "come")
    out = d / f"{_stem(path)}.{ext}"
    if not out.exists() or out.stat().st_size != os.path.getsize(path):
        shutil.copyfile(path, out)
    return {"ok": True, "path": str(out)}


def write_bytes(path: str, name: str, data: bytes) -> dict:
    """File prodotto dall'interfaccia (es. DXF dal DWG riletto con libredwg) nella cartella di recupero."""
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)[:150]
    out = _outdir(path) / safe
    out.write_bytes(data)
    return {"ok": True, "path": str(out)}


def out_path(path: str, name: str) -> dict:
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)[:150]
    return {"ok": True, "path": str(_outdir(path) / safe)}
