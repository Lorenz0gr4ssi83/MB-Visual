"""eBook Kindle (.mobi .prc .azw .azw3 .kf8) senza DRM e libri Calibre .htmlz/.txtz -> EPUB in cache, aperto dal lettore EPUB.
Scritto qui dalla descrizione pubblica del formato (wiki di MobileRead, "MOBI" e "KF8"): database Palm, compressione PalmDOC,
dati in coda ai record (extra flags), MOBI 6 = un HTML unico diviso ai <mbp:pagebreak>, immagini recindex; KF8 (MOBI 8) = flussi
FDST, indici INDX con TAGX per scheletri e frammenti ricomposti in parti XHTML, immagini kindle:embed e fogli di stile kindle:flow.
Libri con DRM o compressione HUFF/CDIC: messaggio chiaro (non si leggono). Collegamenti interni kindle:pos: non risolti (indice
ricavato dai titoli delle parti)."""
import hashlib
import html
import io
import os
import re
import struct
import uuid
import zipfile

from .i18n import t as tr
from .paths import TEMP_DIR

CACHE = TEMP_DIR / "ebook"
VERSION = 1


class KindleError(ValueError):
    pass


# ------------------------------------------------------------------ database Palm e testo
def _records(b):
    if len(b) < 78 or b[60:68] not in (b"BOOKMOBI", b"TEXtREAd"):
        raise KindleError(tr("srv_kindle.non_kindle"))
    n = struct.unpack_from(">H", b, 76)[0]
    offs = [struct.unpack_from(">I", b, 78 + 8 * i)[0] for i in range(n)] + [len(b)]
    return [b[offs[i]:offs[i + 1]] for i in range(n)]


def _palmdoc(d):
    out = bytearray()
    i, n = 0, len(d)
    while i < n:
        c = d[i]
        i += 1
        if 1 <= c <= 8:
            out += d[i:i + c]
            i += c
        elif c < 0x80:
            out.append(c)
        elif c >= 0xC0:
            out.append(0x20)
            out.append(c ^ 0x80)
        else:
            if i >= n:
                break
            c = (c << 8) | d[i]
            i += 1
            dist, ln = (c >> 3) & 0x7FF, (c & 7) + 3
            if dist == 0 or dist > len(out):
                continue
            for _ in range(ln):
                out.append(out[-dist])
    return bytes(out)


def _trim(data, flags):
    trailers = bin(flags >> 1).count("1")
    for _ in range(trailers):
        num = 0
        for v in data[-4:]:
            if v & 0x80:
                num = 0
            num = (num << 7) | (v & 0x7F)
        if num:
            data = data[:-num]
    if flags & 1 and data:
        data = data[:-((data[-1] & 3) + 1)]
    return data


class Book:
    def __init__(self, b: bytes):
        R = _records(b)
        r0 = R[0]
        comp, _, textlen, nrec, _ = struct.unpack_from(">HHIHH", r0, 0)
        enc = struct.unpack_from(">H", r0, 12)[0]
        if enc:
            raise KindleError(tr("srv_kindle.drm"))
        if comp == 17480:
            raise KindleError(tr("srv_kindle.huff"))
        if comp not in (1, 2):
            raise KindleError(tr("srv_kindle.compressione", comp))
        self.R, self.r0 = R, r0
        self.mobi = r0[16:20] == b"MOBI"
        hl = struct.unpack_from(">I", r0, 20)[0] if self.mobi else 0
        self.codec = "utf-8" if not self.mobi or struct.unpack_from(">I", r0, 28)[0] == 65001 else "cp1252"
        self.version = struct.unpack_from(">I", r0, 36)[0] if self.mobi else 0
        self.first_img = struct.unpack_from(">I", r0, 0x6C)[0] if self.mobi and hl >= 0x5C else 0xFFFFFFFF
        flags = struct.unpack_from(">H", r0, 0xF2)[0] if self.mobi and hl >= 0xE4 else 0
        self.exth = {}
        if self.mobi and struct.unpack_from(">I", r0, 0x80)[0] & 0x40:
            e = r0[16 + hl:]
            if e[:4] == b"EXTH":
                cnt, p = struct.unpack_from(">I", e, 8)[0], 12
                for _ in range(cnt):
                    tg, ln = struct.unpack_from(">II", e, p)
                    self.exth.setdefault(tg, e[p + 8:p + ln])
                    p += ln
        name_off, name_len = (struct.unpack_from(">II", r0, 0x54) if self.mobi else (0, 0))
        title = self.exth.get(503) or (r0[name_off:name_off + name_len] if name_len else b[:32].rstrip(b"\x00"))
        self.title = title.decode(self.codec, "replace").strip()
        self.author = self.exth.get(100, b"").decode(self.codec, "replace").strip()
        self.lang = "en"
        raw = bytearray()
        for i in range(1, min(nrec, len(R) - 1) + 1):
            d = _trim(R[i], flags)
            raw += _palmdoc(d) if comp == 2 else d
        self.raw = bytes(raw[:textlen]) if textlen else bytes(raw)
        if self.version >= 8:
            self.fdst = struct.unpack_from(">I", r0, 0xC0)[0]
            self.frag_idx = struct.unpack_from(">I", r0, 0xF8)[0]
            self.skel_idx = struct.unpack_from(">I", r0, 0xFC)[0]

    # immagini e risorse: numero (da 1) -> (byte, tipo)
    def resource(self, n):
        i = self.first_img + n - 1
        if not (0 <= i < len(self.R)) or self.first_img == 0xFFFFFFFF:
            return None
        d = self.R[i]
        for magic, mime in ((b"\xff\xd8", "image/jpeg"), (b"\x89PNG", "image/png"), (b"GIF8", "image/gif"), (b"BM", "image/bmp")):
            if d.startswith(magic):
                return d, mime
        if d[:4] == b"FONT":
            return None
        return None

    # ---------------------------------------------------------- KF8
    def _index(self, idx):
        main = self.R[idx]
        if main[:4] != b"INDX":
            raise KindleError(tr("srv_kindle.indice"))
        hlen, count = struct.unpack_from(">I", main, 4)[0], struct.unpack_from(">I", main, 24)[0]
        tags, cbc = [], 1
        if main[hlen:hlen + 4] == b"TAGX":
            first = struct.unpack_from(">I", main, hlen + 4)[0]
            cbc = struct.unpack_from(">I", main, hlen + 8)[0]
            for p in range(hlen + 12, hlen + first, 4):
                tags.append(tuple(main[p:p + 4]))
        out = []
        for r in range(idx + 1, idx + 1 + count):
            d = self.R[r]
            start, n = struct.unpack_from(">I", d, 20)[0], struct.unpack_from(">I", d, 24)[0]
            pos = [struct.unpack_from(">H", d, start + 4 + 2 * j)[0] for j in range(n)] + [start]
            for j in range(n):
                s, e = pos[j], pos[j + 1]
                tl = d[s]
                text = d[s + 1:s + 1 + tl]
                out.append((text, _tagmap(cbc, tags, d, s + 1 + tl, e)))
        return out

    def kf8_parts(self):
        raw = self.raw
        flows = [raw]
        f = self.R[self.fdst] if self.fdst < len(self.R) else b""
        if f[:4] == b"FDST":
            cnt = struct.unpack_from(">I", f, 8)[0]
            flows = [raw[struct.unpack_from(">I", f, 12 + 8 * k)[0]:struct.unpack_from(">I", f, 16 + 8 * k)[0]] for k in range(cnt)]
        text = flows[0]
        skel = self._index(self.skel_idx)
        frag = self._index(self.frag_idx)
        parts, fp = [], 0
        for _name, tm in skel:
            cnt = tm.get(1, [0])[0]
            spos, slen = tm[6][0], tm[6][1]
            base = spos + slen
            sk = text[spos:base]
            for _ in range(cnt):
                if fp >= len(frag):
                    break
                ftext, ftm = frag[fp]
                ins = int(ftext.decode("ascii")) - spos
                ln = ftm[6][1]
                sk = sk[:ins] + text[base:base + ln] + sk[ins:]
                base += ln
                fp += 1
            parts.append(sk)
        return parts, flows


def _varw(d, p):
    v, n = 0, 0
    while True:
        c = d[p + n]
        n += 1
        v = (v << 7) | (c & 0x7F)
        if c & 0x80:
            return n, v


def _tagmap(cbc, table, d, start, end):
    tags, ci, ds = [], 0, start + cbc
    for tag, vpe, mask, endf in table:
        if endf == 1:
            ci += 1
            continue
        cb = d[start + ci]
        v = cb & mask
        if not v:
            continue
        if v == mask and bin(mask).count("1") > 1:
            n, ln = _varw(d, ds)
            ds += n
            tags.append((tag, None, ln, vpe))
        else:
            m = mask
            while not m & 1:
                m >>= 1
                v >>= 1
            tags.append((tag, v, None, vpe))
    out = {}
    for tag, cnt, nbytes, vpe in tags:
        vals = []
        if cnt is not None:
            for _ in range(cnt * vpe):
                n, x = _varw(d, ds)
                ds += n
                vals.append(x)
        else:
            used = 0
            while used < nbytes:
                n, x = _varw(d, ds)
                ds += n
                used += n
                vals.append(x)
        out[tag] = vals
    return out


# ------------------------------------------------------------------ EPUB
def _xhtml(fragment: str, title: str) -> str:
    """HTML qualsiasi -> XHTML ben formato (lxml)"""
    import lxml.html
    from lxml import etree
    fragment = re.sub(r"^\s*<\?xml[^>]*\?>", "", fragment or "")  # lxml rifiuta il testo con la dichiarazione di codifica
    try:
        doc = lxml.html.document_fromstring(fragment or "<p></p>")
    except Exception:  # noqa: BLE001
        doc = lxml.html.document_fromstring("<p>" + html.escape(fragment or "") + "</p>")
    for el in doc.iter():
        if not isinstance(el.tag, str):
            continue
        if ":" in el.tag:  # mbp:pagebreak & co.
            el.tag = "span"
        for k in list(el.attrib):
            if ":" in k or not re.fullmatch(r"[A-Za-z_][\w.-]*", k):
                del el.attrib[k]
    body = doc.find("body")
    head = doc.find("head")
    styles = "".join(etree.tostring(s, encoding="unicode", method="xml") for s in (head.findall("link") + head.findall("style") if head is not None else []))
    inner = etree.tostring(body, encoding="unicode", method="xml") if body is not None else "<body/>"
    inner = re.sub(r"^<body", '<body', inner)
    return ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>'
            f"<title>{html.escape(title)}</title>{styles}</head>{inner}</html>")


def _heading(xh: str, n: int) -> str:
    m = re.search(r"<h[1-3][^>]*>(.*?)</h[1-3]>", xh, re.S | re.I)
    if m:
        s = html.unescape(re.sub(r"<[^>]+>", " ", m.group(1)))
        s = re.sub(r"\s+", " ", s).strip()
        if s:
            return s[:120]
    return tr("srv_kindle.parte", n)


def _epub(title, author, lang, chapters, files):
    """chapters: [(nome.xhtml, xhtml)], files: {nome: (byte, mime)}"""
    bid = "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, title + author))
    buf = io.BytesIO()
    z = zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED)
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
               '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    man, spine, nav = [], [], []
    for i, (name, xh) in enumerate(chapters):
        z.writestr("OEBPS/" + name, xh)
        man.append(f'<item id="c{i}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="c{i}"/>')
        nav.append(f'<li><a href="{name}">{html.escape(_heading(xh, i + 1))}</a></li>')
    for k, (name, (data, mime)) in enumerate(files.items()):
        z.writestr("OEBPS/" + name, data)
        man.append(f'<item id="r{k}" href="{name}" media-type="{mime}"/>')
    z.writestr("OEBPS/nav.xhtml", '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
               f'<head><title>{html.escape(title)}</title></head><body><nav epub:type="toc"><ol>{"".join(nav)}</ol></nav></body></html>')
    ncx = "".join(f'<navPoint id="n{i}" playOrder="{i + 1}"><navLabel><text>{html.escape(_heading(xh, i + 1))}</text></navLabel><content src="{name}"/></navPoint>'
                  for i, (name, xh) in enumerate(chapters))
    z.writestr("OEBPS/toc.ncx", f'<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="{bid}"/></head>'
               f'<docTitle><text>{html.escape(title)}</text></docTitle><navMap>{ncx}</navMap></ncx>')
    z.writestr("OEBPS/content.opf", f'<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
               f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">{bid}</dc:identifier><dc:title>{html.escape(title)}</dc:title>'
               f'<dc:creator>{html.escape(author)}</dc:creator><dc:language>{html.escape(lang)}</dc:language></metadata>'
               f'<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>{"".join(man)}</manifest>'
               f'<spine toc="ncx">{"".join(spine)}</spine></package>')
    z.close()
    return buf.getvalue()


EXT_OF = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/bmp": "bmp"}


def _from_kindle(b: bytes):
    B = Book(b)
    files = {}

    def img(n):
        r = B.resource(n)
        if not r:
            return None
        name = f"img{n:04d}.{EXT_OF[r[1]]}"
        files[name] = r
        return name

    chapters = []
    cover = B.exth.get(201)
    if cover and len(cover) == 4:  # copertina: numero della risorsa (da 0) nell'EXTH
        name = img(struct.unpack(">I", cover)[0] + 1)
        if name:
            chapters.append(("cover.xhtml", _xhtml(f'<div style="text-align:center"><img src="{name}" style="max-width:100%;max-height:100%"/></div>', B.title)))
    if B.version >= 8:
        parts, flows = B.kf8_parts()
        for k in range(1, len(flows)):
            fl = flows[k]
            if fl.lstrip()[:5] in (b"<?xml", b"<svg ") or b"<svg" in fl[:200]:
                files[f"flow{k:04d}.svg"] = (fl, "image/svg+xml")
            else:
                files[f"flow{k:04d}.css"] = (fl, "text/css")

        def fix(s):
            s = re.sub(r"kindle:embed:([0-9A-V]{4})(\?mime=[^\"')]*)?", lambda m: img(int(m.group(1), 32)) or "", s)
            s = re.sub(r"kindle:flow:([0-9A-V]{4})\?mime=([^\"')]*)", lambda m: f"flow{int(m.group(1), 32):04d}." + ("svg" if "svg" in m.group(2) else "css"), s)
            return re.sub(r'href="kindle:pos:[^"]*"', 'href="#"', s)

        for i, p in enumerate(parts):
            chapters.append((f"part{i:04d}.xhtml", _xhtml(fix(p.decode(B.codec, "replace")), B.title)))
    else:
        text = B.raw.decode(B.codec, "replace")
        text = re.sub(r'recindex="0*(\d+)"', lambda m: f'src="{img(int(m.group(1))) or ""}"', text)
        text = re.sub(r'(<a [^>]*?)filepos=\d+', r'\1href="#"', text)
        pieces = [x for x in re.split(r"<mbp:pagebreak\s*/?>", text, flags=re.I) if re.sub(r"<[^>]+>|\s", "", x)]
        if not pieces:
            pieces = [text]
        for i, p in enumerate(pieces):
            chapters.append((f"part{i:04d}.xhtml", _xhtml(p, B.title)))
    return _epub(B.title, B.author, B.lang, chapters, files)


def _from_htmlz(path: str):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        meta = next((n for n in names if n.endswith(".opf")), None)
        title, author = os.path.splitext(os.path.basename(path))[0], ""
        if meta:
            m = z.read(meta).decode("utf-8", "replace")
            t = re.search(r"<dc:title[^>]*>(.*?)</dc:title>", m, re.S)
            a = re.search(r"<dc:creator[^>]*>(.*?)</dc:creator>", m, re.S)
            title = html.unescape(t.group(1)).strip() if t else title
            author = html.unescape(a.group(1)).strip() if a else ""
        main = "index.html" if "index.html" in names else next((n for n in names if n.lower().endswith((".html", ".htm", ".txt", ".md", ".textile"))), None)
        if not main:
            raise KindleError(tr("srv_kindle.vuoto"))
        body = z.read(main).decode("utf-8", "replace")
        if not main.lower().endswith((".html", ".htm")):  # txtz: testo, Markdown o Textile
            try:
                import markdown
                body = markdown.markdown(body)
            except Exception:  # noqa: BLE001
                body = "".join(f"<p>{html.escape(p)}</p>" for p in re.split(r"\n\s*\n", body))
        files = {}
        base = os.path.dirname(main)
        for n in names:
            low = n.lower()
            mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "svg": "image/svg+xml", "css": "text/css"}.get(low.rsplit(".", 1)[-1])
            if mime and not n.endswith("/"):
                rel = n[len(base) + 1:] if base and n.startswith(base + "/") else n
                files[rel] = (z.read(n), mime)
    return _epub(title, author, "en", [("index.xhtml", _xhtml(body, title))], files)


def to_epub(path: str, update=lambda *a, **k: None) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}|{VERSION}".encode()).hexdigest()[:16]
    out = CACHE / f"{key}.epub"
    if out.exists():
        return {"ok": True, "path": str(out), "cache": True}
    update(progress=0.1, message=tr("srv_kindle.lettura"))
    with open(path, "rb") as f:
        head = f.read(4)
    if head == b"PK\x03\x04":
        data = _from_htmlz(path)
    else:
        with open(path, "rb") as f:
            data = _from_kindle(f.read())
    tmp = out.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, out)
    return {"ok": True, "path": str(out)}
