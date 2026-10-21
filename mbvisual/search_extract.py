"""Estrazione del testo per la ricerca nel progetto (mbvisual/search.py).

Ogni estrattore riempie un `Out` con blocchi (loc, etichetta, testo, posizioni):
- loc: dove si trova il blocco nel file ({"page": 3}, {"sheet": "Foglio1"}, {"slide": 2}, {"line": 120}, {"attach": "a.pdf"})
- posizioni: per i blocchi composti da tante voci (celle, entita' CAD, elementi IFC) l'elenco [scostamento, valore]
  che permette di risalire dalla parola trovata alla voce precisa (cella B4, handle 1A2, elemento #123).
I file si leggono solo se sono sul PC: i file "solo online" di OneDrive non arrivano mai qui (li scarta search.py).
"""
import email
import email.policy
import html
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from .i18n import t as tr

CHUNK = 4000                 # caratteri per blocco: l'anteprima e il punto trovato restano precisi
MAX_CHARS = 8_000_000        # testo massimo per file (oltre: si avvisa che il resto non e' indicizzato)
MAX_CHARS_BIG = 40_000_000   # IFC e fogli molto grandi
TEXT_MAX_BYTES = 64 * 1024 * 1024

_UI = Path(__file__).resolve().parent.parent / "ui"


def _registry_exts():
    """Estensioni di testo dal registro dei formati (ui/formats.json): testo, codice, markdown, html, svg."""
    from .paths import UI_DIR
    for base in (UI_DIR, _UI):
        try:
            reg = json.loads((base / "formats.json").read_text(encoding="utf-8"))
            break
        except OSError:
            continue
    else:
        return {}
    out = {}
    for c in reg.get("categories", []):
        for e in c.get("exts", []):
            out.setdefault(e.lower(), c["id"])
    return out


CAT = _registry_exts()
TEXT_CATS = {"text", "markdown", "html", "svg"}
OOXML_WORD = {"docx", "docm", "dotx", "dotm"}
OOXML_SHEET = {"xlsx", "xlsm", "xltx", "xltm"}
OOXML_SLIDE = {"pptx", "pptm", "potx", "potm", "ppsx", "ppsm"}
ODF = {"odt", "ott", "ods", "ots", "odp", "otp", "odg", "otg"}
OLE_OFFICE = {"doc", "dot", "xls", "xlt", "xla", "ppt", "pps", "pot", "pub", "vsd"}
EMAIL = {"eml", "msg", "mbox", "mbx", "emlx"}
SIGNED = {"p7m", "p7s", "tsd", "m7m"}
ZIPLIKE = {"zip", "zipx", "jar", "apk", "nupkg", "kmz"}
IMAGES_META = {"jpg", "jpeg", "jpe", "jfif", "tif", "tiff", "png", "heic", "heif", "webp", "dng", "nef", "cr2", "arw", "orf", "rw2", "gif", "bmp"}


def kind_of(ext: str) -> str:
    """Famiglia per il filtro "Tipo" del pannello di ricerca."""
    e = ext.lower()
    cat = CAT.get(e)
    if e == "pdf" or cat == "signed":
        return "pdf"
    if e in OOXML_WORD or e in {"doc", "dot", "rtf", "odt", "ott", "fodt", "wpd", "pages"}:
        return "word"
    if cat == "sheet" or e in {"ods", "ots"}:
        return "excel"
    if cat == "pptx" or e in {"ppt", "pps", "pot", "odp", "otp", "fodp", "key"}:
        return "powerpoint"
    if cat == "email":
        return "email"
    if cat in ("cad2d",) or e in {"dwg", "dxf", "dwf", "dwfx"}:
        return "cad"
    if cat == "cad3d":
        return "cad"
    if e in {"ifc", "ifczip", "ifcxml", "nwd", "nwc", "nwf", "rvt", "rfa"}:
        return "bim"
    if cat in ("image", "image-raw", "svg"):
        return "immagine"
    if cat in TEXT_CATS:
        return "testo"
    if cat == "archive":
        return "archivio"
    return "altro"


# ---------------------------------------------------------------- raccolta del testo
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def L(key: str, *args) -> str:
    """Etichetta o avviso salvati nell'indice come chiave: si traducono nella lingua dell'interfaccia alla ricerca
    (search.tr_label). Gli argomenti possono essere a loro volta etichette L(...)."""
    return json.dumps(["srv_search." + key, *args], ensure_ascii=False)


def clean(s: str) -> str:
    return _CTRL.sub(" ", s or "")


class Out:
    def __init__(self, limit=MAX_CHARS):
        self.chunks = []      # (loc, label, text, pos)
        self.meta = {}        # proprieta' del documento (titolo, autore...)
        self.note = None      # avviso mostrato nei risultati (es. "PDF senza testo")
        self.chars = 0
        self.limit = limit
        self.full = False

    def _room(self, n):
        if self.chars + n > self.limit:
            self.full = True
            self.note = self.note or L("nota_troncato")
            return False
        self.chars += n
        return True

    def add(self, loc, label, text, pos=None):
        text = clean(text).strip()
        if not text or self.full:
            return
        # testi lunghi: piu' blocchi con la stessa posizione (righe: la prima riga di ogni blocco)
        if len(text) <= CHUNK * 1.5 or pos:
            if self._room(len(text)):
                self.chunks.append((loc, label, text, pos))
            return
        start, line = 0, (loc or {}).get("line")
        while start < len(text) and not self.full:
            end = min(len(text), start + CHUNK)
            if end < len(text):
                cut = text.rfind("\n", start + CHUNK // 2, end)
                if cut < 0:
                    cut = text.rfind(" ", start + CHUNK // 2, end)
                end = cut + 1 if cut > 0 else end
            part = text[start:end]
            l2 = dict(loc or {})
            if line is not None:
                l2["line"] = line + text.count("\n", 0, start)
            if self._room(len(part)):
                self.chunks.append((l2, label, part, None))
            start = end

    def items(self, loc, label, key, items):
        """Voci (valore di posizione, testo): blocchi da ~CHUNK caratteri con le posizioni di ogni voce."""
        buf, offs, vals, n = [], [], [], 0
        for v, t in items:
            if self.full:
                return
            t = clean(t).replace("\n", " ").strip()
            if not t:
                continue
            offs.append(n)
            vals.append(v)
            buf.append(t)
            n += len(t) + 1
            if n >= CHUNK:
                self._flush(loc, label, key, buf, offs, vals)
                buf, offs, vals, n = [], [], [], 0
        if buf:
            self._flush(loc, label, key, buf, offs, vals)

    def _flush(self, loc, label, key, buf, offs, vals):
        text = "\n".join(buf)
        if self._room(len(text)):
            self.chunks.append((loc, label, text, {"k": key, "o": offs, "v": vals}))


def extract(path: str, ext: str, tmpdir: str | None = None, depth: int = 0) -> Out:
    """Testo del file per l'indice. Gli errori salgono al chiamante (che segna il file come non leggibile)."""
    e = ext.lower()
    big = e in ("ifc",) or e in OOXML_SHEET
    out = Out(MAX_CHARS_BIG if big else MAX_CHARS)
    cat = CAT.get(e)
    if e == "pdf":
        _pdf(path, out)
    elif e in OOXML_WORD:
        _docx(path, out)
    elif e in OOXML_SHEET:
        _xlsx(path, out)
    elif e in OOXML_SLIDE:
        _pptx(path, out)
    elif e in ODF or e in {"fodt", "fods", "fodp"}:
        _odf(path, out, e)
    elif e in OLE_OFFICE:
        _ole(path, out, e)
    elif e == "rtf":
        _rtf(path, out)
    elif e in ("eml", "emlx"):
        with open(path, "rb") as f:
            msg = email.message_from_binary_file(f, policy=email.policy.default)
        _email_msg(msg, out, "", tmpdir, depth)
    elif e == "msg":
        _msg(path, out, tmpdir, depth)
    elif e in ("mbox", "mbx"):
        _mbox(path, out, tmpdir, depth)
    elif e == "dxf":
        _dxf(path, out)
    elif e == "ifc":
        _ifc(path, out)
    elif e in ("step", "stp", "p21"):
        _step(path, out)
    elif e in SIGNED and depth < 2:
        _signed(path, out, tmpdir, depth)
    elif e in ZIPLIKE or (cat == "archive" and depth == 0):
        _archive(path, out, e)
    elif e in IMAGES_META:
        _image(path, out)
    elif cat in TEXT_CATS or e in ("csv", "tsv"):
        _text(path, out, cat or "text")
    return out


# ---------------------------------------------------------------- PDF
def _pdf(path, out):
    import pymupdf
    doc = pymupdf.open(path)
    try:
        if doc.needs_pass:
            out.note = L("nota_pdf_password")
            return
        ids = {"title": "titolo", "author": "autore", "subject": "oggetto", "keywords": "parole_chiave", "creator": "creatore", "producer": "produttore"}
        for k, v in (doc.metadata or {}).items():
            if v and k in ids:
                out.meta[ids[k]] = v
        testo = 0
        for i, page in enumerate(doc):
            t = page.get_text("text")
            testo += len(t.strip())
            notes = []
            for a in page.annots() or []:
                c = (a.info or {}).get("content") or ""
                if c.strip():
                    notes.append(c)
            if notes:
                t += "\n" + "\n".join(notes)
            out.add({"page": i + 1}, L("pagina", i + 1), t)
            if out.full:
                break
        if doc.page_count and testo < 20 * min(doc.page_count, 5) and not out.full:
            out.note = L("nota_pdf_scansione")
    finally:
        doc.close()


# ---------------------------------------------------------------- XML di Office
def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _xml_props(z: zipfile.ZipFile, out: Out, name="docProps/core.xml"):
    try:
        root = ET.fromstring(z.read(name))
    except (KeyError, ET.ParseError):
        return
    keep = {"title": "titolo", "subject": "oggetto", "creator": "autore", "keywords": "parole_chiave", "description": "descrizione",
            "lastModifiedBy": "modificato_da", "category": "categoria", "Company": "societa", "Manager": "responsabile",
            "initial-creator": "autore", "keyword": "parole_chiave"}
    for el in root.iter():
        k = _local(el.tag)
        if k in keep and (el.text or "").strip():
            out.meta[keep[k]] = el.text.strip()


def _paras(data: bytes, para="p", text="t", tab="tab", br=("br", "cr")):
    """Paragrafi di un XML di Word/PowerPoint: (stile, testo)."""
    cur, style, out = [], "", []
    for ev, el in ET.iterparse(_bio(data), events=("end",)):
        k = _local(el.tag)
        if k == text:
            cur.append(el.text or "")
        elif k == tab:
            cur.append("\t")
        elif k in br:
            cur.append("\n")
        elif k == "pStyle":
            style = next((v for a, v in el.attrib.items() if _local(a) == "val"), "")
        elif k == para:
            out.append((style, "".join(cur)))
            cur, style = [], ""
            el.clear()
    return out


def _bio(data):
    import io
    return io.BytesIO(data)


def _docx(path, out):
    with zipfile.ZipFile(path) as z:
        _xml_props(z, out)
        _xml_props(z, out, "docProps/app.xml")
        names = z.namelist()
        # corpo del documento: blocchi che portano come etichetta l'ultimo titolo incontrato
        label, buf = L("testo"), []

        def flush():
            if buf:
                out.add({"find": True}, label, "\n".join(buf))
                buf.clear()
        n = 0
        for style, t in _paras(z.read("word/document.xml")):
            if re.match(r"(?i)(heading|titolo|title)", style or "") and t.strip():
                flush()
                label = t.strip()[:80]
            buf.append(t)
            n += len(t)
            if n > CHUNK:
                flush()
                n = 0
        flush()
        extra = sorted(x for x in names if re.match(r"word/(header|footer|footnotes|endnotes|comments)\d*\.xml$", x))
        for x in extra:
            what = {"header": "intestazione", "footer": "pie_pagina", "footnotes": "note_pie", "endnotes": "note_chiusura", "comments": "commenti"}
            k = re.match(r"word/([a-z]+)", x).group(1)
            out.add({"find": True}, L(what[k]) if k in what else k, "\n".join(t for _, t in _paras(z.read(x))))


def _col(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _xlsx(path, out):
    with zipfile.ZipFile(path) as z:
        _xml_props(z, out)
        names = set(z.namelist())
        shared = []
        if "xl/sharedStrings.xml" in names:
            cur = []
            for ev, el in ET.iterparse(z.open("xl/sharedStrings.xml"), events=("end",)):
                k = _local(el.tag)
                if k == "t":
                    cur.append(el.text or "")
                elif k == "si":
                    shared.append("".join(cur))
                    cur = []
                    el.clear()
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = {r.get("Id"): r.get("Target") for r in rels}
        for sh in wb.iter():
            if _local(sh.tag) != "sheet":
                continue
            name = sh.get("name")
            rid = next((v for a, v in sh.attrib.items() if _local(a) == "id"), None)
            t = target.get(rid, "")
            p = t.lstrip("/") if t.startswith("/") else "xl/" + t
            if p not in names:
                continue

            def cells(p=p):
                ref, typ, val, inl = None, None, None, []
                for ev, el in ET.iterparse(z.open(p), events=("start", "end")):
                    k = _local(el.tag)
                    if ev == "start":
                        if k == "c":
                            ref, typ, val, inl = el.get("r"), el.get("t"), None, []
                        continue
                    if k == "v":
                        val = el.text
                    elif k == "t":
                        inl.append(el.text or "")
                    elif k == "c":
                        if typ == "s" and val is not None:
                            try:
                                v = shared[int(val)]
                            except (ValueError, IndexError):
                                v = ""
                        elif typ == "inlineStr":
                            v = "".join(inl)
                        elif typ == "b":
                            v = tr("srv_search.vero" if val == "1" else "srv_search.falso")
                        else:
                            v = val or ""
                        if v and ref:
                            yield ref, f"{ref}: {v}"
                        el.clear()
                    elif k == "row":
                        el.clear()
            out.items({"sheet": name}, L("foglio", name), "cell", cells())
            if out.full:
                break


def _pptx(path, out):
    with zipfile.ZipFile(path) as z:
        _xml_props(z, out)
        names = set(z.namelist())
        pres = ET.fromstring(z.read("ppt/presentation.xml"))
        rels = ET.fromstring(z.read("ppt/_rels/presentation.xml.rels"))
        target = {r.get("Id"): r.get("Target") for r in rels}
        order = []
        for s in pres.iter():
            if _local(s.tag) == "sldId":
                rid = next((v for a, v in s.attrib.items() if _local(a) == "id" and a.startswith("{")), None)
                if rid in target:
                    order.append("ppt/" + target[rid].lstrip("/").replace("ppt/", "", 1) if not target[rid].startswith("/") else target[rid].lstrip("/"))
        if not order:
            order = sorted((n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=lambda n: int(re.findall(r"\d+", n)[-1]))
        for i, sp in enumerate(order, 1):
            if sp not in names:
                continue
            txt = "\n".join(t for _, t in _paras(z.read(sp)))
            # note del relatore
            rp = sp.replace("slides/", "slides/_rels/") + ".rels"
            if rp in names:
                for r in ET.fromstring(z.read(rp)):
                    if r.get("Type", "").endswith("/notesSlide"):
                        np = os.path.normpath(os.path.join(os.path.dirname(sp), r.get("Target"))).replace("\\", "/")
                        if np in names:
                            notes = "\n".join(t for _, t in _paras(z.read(np)))
                            if notes.strip():
                                txt += "\n" + tr("srv_search.note_relatore") + ": " + notes
            out.add({"slide": i}, L("diapositiva", i), txt)


# ---------------------------------------------------------------- OpenDocument
def _odf(path, out, ext):
    if ext.startswith("f"):  # documento piatto (XML unico)
        data = Path(path).read_bytes()
        _odf_content(data, out, ext)
        return
    with zipfile.ZipFile(path) as z:
        _xml_props(z, out, "meta.xml")
        _odf_content(z.read("content.xml"), out, ext)


def _odf_text(el):
    parts = []
    for x in el.iter():
        k = _local(x.tag)
        if x.text and k not in ("annotation",):
            parts.append(x.text)
        if k == "s":
            parts.append(" ")
        elif k == "tab":
            parts.append("\t")
        elif k == "line-break":
            parts.append("\n")
        if x is not el and x.tail:
            parts.append(x.tail)
    return "".join(parts)


def _odf_content(data, out, ext):
    root = ET.fromstring(data)
    body = next((x for x in root.iter() if _local(x.tag) in ("spreadsheet", "presentation", "text", "drawing")), root)
    kind = _local(body.tag)
    if kind == "spreadsheet":
        for tb in body:
            if _local(tb.tag) != "table":
                continue
            name = next((v for a, v in tb.attrib.items() if _local(a) == "name"), "1")

            def cells(tb=tb):
                r = 0
                for row in tb.iter():
                    if _local(row.tag) != "table-row":
                        continue
                    rep = int(next((v for a, v in row.attrib.items() if _local(a) == "number-rows-repeated"), 1))
                    r += 1
                    c = 0
                    for cell in row:
                        if _local(cell.tag) not in ("table-cell", "covered-table-cell"):
                            continue
                        crep = int(next((v for a, v in cell.attrib.items() if _local(a) == "number-columns-repeated"), 1))
                        c += 1
                        t = "\n".join(_odf_text(p) for p in cell if _local(p.tag) == "p")
                        if t.strip():
                            ref = f"{_col(c)}{r}"
                            yield ref, f"{ref}: {t}"
                        c += crep - 1
                    r += rep - 1 if rep < 100000 else 0
            out.items({"sheet": name}, L("foglio", name), "cell", cells())
    elif kind in ("presentation", "drawing"):
        i = 0
        for pg in body:
            if _local(pg.tag) != "page":
                continue
            i += 1
            t = "\n".join(_odf_text(p) for p in pg.iter() if _local(p.tag) in ("p", "h"))
            out.add({"slide": i}, L("diapositiva", i), t)
    else:
        lines, label = [], L("testo")
        for p in body.iter():
            k = _local(p.tag)
            if k == "h":
                if lines:
                    out.add({"find": True}, label, "\n".join(lines))
                    lines = []
                label = _odf_text(p).strip()[:80] or L("testo")
                lines.append(label)
            elif k == "p":
                lines.append(_odf_text(p))
        out.add({"find": True}, label, "\n".join(lines))


# ---------------------------------------------------------------- Office binario (doc, xls, ppt): testo ricavato dai flussi
_U16 = re.compile(rb"(?:[\x20-\x7e\xa0-\xff][\x00]|[\x00-\xff][\x01-\x04\x20]){4,}")
_A8 = re.compile(rb"[\x20-\x7e\xa0-\xff\t\r\n]{5,}")


_ODD = re.compile(r"[^\w\s.,;:!?'\"()\[\]/%&+\-=*#@€°<>]|[\u0080-\u00bf\u00c1-\u00c7\u00ca\u00cb\u00cd-\u00d1\u00d3-\u00d8\u00da-\u00df\u00e1-\u00e7\u00ea\u00eb\u00ed-\u00f1\u00f3-\u00f8\u00fa-\u00ff]")  # simboli e lettere latine poco usate in italiano


def _wordy(s: str) -> bool:
    """Sequenza che sembra testo (lettere e punteggiatura comune), non spazzatura binaria."""
    letters = sum(ch.isalpha() for ch in s)
    return letters >= len(s) * 0.5 and len(_ODD.findall(s)) <= len(s) * 0.05 and bool(re.search(r"[aeiouAEIOU]", s))


def _strings(data: bytes) -> list[str]:
    seen, res = set(), []
    for m in _U16.finditer(data):
        s = m.group().decode("utf-16-le", "ignore").strip()
        if len(s) >= 4 and s not in seen and _wordy(s):
            seen.add(s)
            res.append(s)
    for m in _A8.finditer(data):
        s = m.group().decode("cp1252", "ignore").strip()
        if len(s) >= 5 and s not in seen and _wordy(s):
            seen.add(s)
            res.append(s)
    return res


def _ole(path, out, ext):
    import olefile
    if not olefile.isOleFile(path):
        return
    with olefile.OleFileIO(path) as ole:
        try:
            m = ole.get_metadata()
            for k, lab in (("title", "titolo"), ("subject", "oggetto"), ("author", "autore"), ("keywords", "parole_chiave"),
                           ("comments", "commenti"), ("last_saved_by", "modificato_da"), ("company", "societa")):
                v = getattr(m, k, None)
                if isinstance(v, bytes):
                    v = v.decode("cp1252", "ignore")
                if v and str(v).strip():
                    out.meta[lab] = str(v).strip()
        except Exception:  # noqa: BLE001
            pass
        streams = {"doc": ["WordDocument"], "dot": ["WordDocument"], "xls": ["Workbook", "Book"], "xlt": ["Workbook", "Book"], "xla": ["Workbook"],
                   "ppt": ["PowerPoint Document"], "pps": ["PowerPoint Document"], "pot": ["PowerPoint Document"], "pub": ["Quill/QuillSub/CONTENTS", "Contents"],
                   "vsd": ["VisioDocument"]}.get(ext, [])
        txt = []
        for s in streams:
            if ole.exists(s):
                data = ole.openstream(s).read(64 * 1024 * 1024)
                txt += _strings(data)
        if ext in ("doc", "dot") and ole.exists("1Table"):
            pass  # il testo di Word e' nel flusso WordDocument: la tabella contiene solo la struttura
        out.add({"find": True}, L("testo"), "\n".join(txt))
        out.note = out.note or L("nota_office_binario")


def _rtf(path, out):
    with open(path, "rb") as f:
        s = f.read(min(TEXT_MAX_BYTES, os.path.getsize(path))).decode("latin-1")
    s = re.sub(r"\{\\\*[^{}]*\}", " ", s)
    s = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1252", "replace"), s)
    s = re.sub(r"\\u(-?\d+)\??", lambda m: chr(int(m.group(1)) % 65536), s)
    s = re.sub(r"\\(par|line|row|cell)\b ?", "\n", s)
    s = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", s)
    s = s.replace("{", "").replace("}", "").replace("\\\\", "\\")
    out.add({"find": True}, L("testo"), s)


# ---------------------------------------------------------------- testo
def decode_text(b: bytes) -> str:
    if b.startswith(b"\xef\xbb\xbf"):
        return b[3:].decode("utf-8", "replace")
    if b.startswith((b"\xff\xfe", b"\xfe\xff")):
        return b.decode("utf-16", "replace")
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("cp1252", "replace")


def _strip_html(s):
    s = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|h\d)>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return html.unescape(s)


def _text(path, out, cat):
    with open(path, "rb") as f:
        b = f.read(min(TEXT_MAX_BYTES, os.path.getsize(path)))  # read(n) prepara un buffer di n byte: con 64 MB costava 40 ms a file
    if b"\x00" in b[:4096] and not b.startswith((b"\xff\xfe", b"\xfe\xff")):
        return  # binario con estensione di testo
    s = decode_text(b)
    if cat in ("html", "svg"):
        title = re.search(r"(?is)<title[^>]*>(.*?)</title>", s)
        if title:
            out.meta["titolo"] = html.unescape(title.group(1)).strip()
        out.add({"find": True}, L("testo"), _strip_html(s))
    else:
        out.add({"line": 1}, L("testo"), s)
    if len(b) >= TEXT_MAX_BYTES:
        out.note = L("nota_testo_grande")


# ---------------------------------------------------------------- email
def _att_extract(name, data, out, tmpdir, depth, prefix=""):
    """Allegato: nome sempre; contenuto se il tipo e' indicizzabile (file temporaneo cancellato subito dopo)."""
    ext = Path(name).suffix.lower().lstrip(".")
    label = L("allegato", name) if not prefix else L("in", prefix, L("allegato", name))
    out.add({"attach": name}, label, tr("srv_search.allegato_testo", name))
    if not data or depth >= 2 or len(data) > 100 * 1024 * 1024 or kind_of(ext) in ("altro",) and ext not in ZIPLIKE:
        return
    d = tempfile.mkdtemp(prefix="mbv-idx-", dir=tmpdir)
    p = os.path.join(d, "a." + (ext or "bin"))
    try:
        with open(p, "wb") as f:
            f.write(data)
        sub = extract(p, ext, tmpdir, depth + 1)
        for k, v in sub.meta.items():
            out.add({"attach": name}, label, f"{k}: {v}")
        for loc, lab, text, pos in sub.chunks:
            out.add({"attach": name, **{k: v for k, v in (loc or {}).items() if k in ("page", "slide", "sheet")}}, L("in", label, lab), text)
    except Exception:  # noqa: BLE001 - allegato illeggibile: resta il nome
        pass
    finally:
        try:
            os.remove(p)
            os.rmdir(d)
        except OSError:
            pass


def _email_msg(msg, out, prefix, tmpdir, depth, loc=None):
    head = {k: str(msg.get(k, "") or "") for k in ("From", "To", "Cc", "Date", "Subject")}
    if not prefix:
        out.meta.update({"da": head["From"], "a": head["To"], "oggetto": head["Subject"], "data": head["Date"]})
    body_text = body_html = None
    atts = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        fname = part.get_filename()
        disp = part.get_content_disposition()
        try:
            payload = part.get_payload(decode=True)
        except Exception:  # noqa: BLE001
            payload = None
        if fname and (disp in ("attachment", "inline") or ctype not in ("text/plain", "text/html")):
            atts.append((fname, payload))
        elif ctype == "text/plain" and body_text is None and payload is not None:
            body_text = payload.decode(part.get_content_charset() or "utf-8", "replace")
        elif ctype == "text/html" and body_html is None and payload is not None:
            body_html = payload.decode(part.get_content_charset() or "utf-8", "replace")
        elif ctype == "message/rfc822":
            pass
    body = body_text if body_text else _strip_html(body_html or "")
    txt = _headers(head["From"], head["To"], head["Cc"], head["Date"], head["Subject"]) + body
    out.add(loc or {"find": True}, L("in", prefix, L("messaggio")) if prefix else L("messaggio"), txt)
    for name, data in atts:
        _att_extract(name, data, out, tmpdir, depth, prefix)


def _headers(da, a, cc, data, oggetto):
    labels = tr("srv_search.intestazioni_email").split("|")  # Da|A|Cc|Data|Oggetto
    vals = [da, a, cc, data, oggetto]
    return "".join(f"{k}: {v or ''}\n" for k, v in zip(labels, vals)) + "\n"


def _msg(path, out, tmpdir, depth):
    import extract_msg
    m = extract_msg.openMsg(path)
    try:
        out.meta.update({"da": m.sender or "", "a": m.to or "", "oggetto": m.subject or "", "data": str(m.date or "")})
        body = m.body or ""
        if not body.strip():
            try:
                hb = m.htmlBody
                body = _strip_html(hb.decode("utf-8", "replace") if isinstance(hb, bytes) else hb or "")
            except Exception:  # noqa: BLE001
                body = ""
        out.add({"find": True}, L("messaggio"), _headers(m.sender, m.to, m.cc, m.date, m.subject) + body)
        for a in m.attachments:
            name = getattr(a, "longFilename", None) or getattr(a, "shortFilename", None) or "allegato"
            data = a.data if isinstance(getattr(a, "data", None), (bytes, bytearray)) else None
            _att_extract(name, bytes(data) if data else None, out, tmpdir, depth)
    finally:
        m.close()


def _mbox(path, out, tmpdir, depth):
    import mailbox
    for i, msg in enumerate(mailbox.mbox(path)):
        if i >= 5000 or out.full:
            break
        em = email.message_from_bytes(msg.as_bytes(), policy=email.policy.default)
        _email_msg(em, out, L("messaggio_n", i + 1), tmpdir, depth + 1, {"msg": i + 1})


# ---------------------------------------------------------------- DXF (lettura diretta dei codici di gruppo: veloce anche su file grandi)
_MTEXT_FMT = re.compile(r"\\[ACcFfHhLlOoKkQqTtWwSs][^;\\]*;|\\[LlOoKk]|[{}]")


def mtext_plain(s: str) -> str:
    s = s.replace("\\P", "\n").replace("\\~", " ")
    s = re.sub(r"\\S([^;^/#]*)[\^/#]([^;]*);", r"\1/\2", s)
    s = _MTEXT_FMT.sub("", s)
    s = re.sub(r"%%[cC]", "Ø", s)
    s = re.sub(r"%%[dD]", "°", s)
    s = re.sub(r"%%[pP]", "±", s)
    s = re.sub(r"\\U\+([0-9A-Fa-f]{4})", lambda m: chr(int(m.group(1), 16)), s)
    return s


TEXT_ENTS = {"TEXT", "MTEXT", "ATTRIB", "ATTDEF", "DIMENSION", "MULTILEADER", "MLEADER", "ACAD_TABLE", "TOLERANCE", "RTEXT", "ARCALIGNEDTEXT"}


def _dxf(path, out):
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:22] == b"AutoCAD Binary DXF\r\n\x1a\x00":
        out.note = L("nota_dxf_binario")
        return
    try:
        s = raw.decode("utf-8")
    except UnicodeDecodeError:
        s = raw.decode("cp1252", "replace")
    del raw
    lines = s.splitlines()
    del s
    n = len(lines) - 1
    section, block = None, None
    layers, blocks = [], []
    model, inblocks = [], {}
    ent = None

    def finish(e):
        if not e:
            return
        typ, h, lay, texts, tag = e["t"], e.get("h"), e.get("l", ""), e.get("x", []), e.get("tag")
        if section == "TABLES":
            return
        if typ in TEXT_ENTS:
            t = "".join(texts) if typ == "MTEXT" else " ".join(texts)
            if typ in ("MTEXT", "MULTILEADER", "MLEADER", "ACAD_TABLE"):
                t = mtext_plain(t)
            if typ == "DIMENSION":
                t = t.replace("<>", "").strip()
            if tag:
                t = f"{tag}={t}"
            if not t.strip():
                return
            line = f"{typ} [{lay}] {t}"
        elif typ == "INSERT" and tag:
            line = f"{tr('srv_search.blocco_inserito')} {tag} [{lay}]"
        else:
            return
        if block is not None:
            inblocks.setdefault(block, []).append((h, line))
        else:
            model.append((h, line))

    i = 0
    while i < n:
        code = lines[i].strip()
        val = lines[i + 1]
        i += 2
        if code == "0":
            finish(ent)
            ent = None
            v = val.strip()
            if v == "SECTION":
                section = None
                continue
            if v == "ENDSEC":
                section = None
                continue
            if v == "BLOCK":
                block = ""
                ent = {"t": "BLOCK"}
                continue
            if v == "ENDBLK":
                block = None
                continue
            ent = {"t": v}
            if section == "TABLES" and v == "LAYER":
                ent["layer"] = True
            continue
        if code == "2" and section is None and ent is None:
            section = val.strip()
            continue
        if ent is None:
            continue
        t = ent["t"]
        if code == "5" or (code == "105" and t == "DIMSTYLE"):
            ent["h"] = val.strip()
        elif code == "8":
            ent["l"] = val.strip()
        elif code == "2":
            if t == "BLOCK":
                block = val.strip()
                if not block.startswith("*"):
                    blocks.append(block)
            elif ent.get("layer"):
                layers.append(val.strip())
            elif t in ("ATTRIB", "ATTDEF", "INSERT"):
                ent["tag"] = val.strip()
        elif code in ("1", "3") and t in TEXT_ENTS:
            if code == "3" and t in ("ATTDEF",):
                continue  # domanda dell'attributo
            ent.setdefault("x", []).append(val)
        elif code in ("304", "302") and t in ("MULTILEADER", "MLEADER"):
            ent.setdefault("x", []).append(val)
    finish(ent)
    out.items({}, L("spazio_modello"), "handle", model)
    for b, items in inblocks.items():
        if items and not b.startswith("*"):
            out.items({"block": b}, L("blocco", b), "handle", items)
    for b, items in inblocks.items():
        if items and b.lower().startswith("*paper_space"):
            out.items({}, L("layout"), "handle", items)
    if layers:
        out.add({}, L("layer"), tr("srv_search.layer") + ": " + ", ".join(layers))
    if blocks:
        out.add({}, L("blocchi"), tr("srv_search.blocchi") + ": " + ", ".join(blocks))


def dwg_items(items: list, layers: list, blocks: list, out: Out):
    """Testi di un DWG letti nell'interfaccia (libredwg): [handle, tipo, layer, testo, blocco]."""
    model, inb = [], {}
    for it in items:
        h, typ, lay, txt, blk = (list(it) + [None] * 5)[:5]
        if typ == "MTEXT":
            txt = mtext_plain(txt or "")
        if typ == "BLOCCO":
            typ = tr("srv_search.blocco_inserito")
        line = f"{typ} [{lay or ''}] {txt or ''}"
        (inb.setdefault(blk, []) if blk else model).append((h, line))
    out.items({}, L("spazio_modello"), "handle", model)
    for b, its in inb.items():
        out.items({"block": b}, L("blocco", b), "handle", its)
    if layers:
        out.add({}, L("layer"), tr("srv_search.layer") + ": " + ", ".join(map(str, layers)))
    if blocks:
        out.add({}, L("blocchi"), tr("srv_search.blocchi") + ": " + ", ".join(map(str, blocks)))


# ---------------------------------------------------------------- IFC (STEP): nomi, proprieta', materiali, piani
_X2 = re.compile(r"\\X2\\([0-9A-Fa-f]+)\\X0\\")
_X1 = re.compile(r"\\X\\([0-9A-Fa-f]{2})")


def step_str(s: str) -> str:
    s = s.replace("''", "'")
    if "\\" in s:
        s = _X2.sub(lambda m: "".join(chr(int(m.group(1)[i:i + 4], 16)) for i in range(0, len(m.group(1)), 4)), s)
        s = _X1.sub(lambda m: bytes([int(m.group(1), 16)]).decode("latin-1"), s)
        s = re.sub(r"\\S\\(.)", lambda m: chr(ord(m.group(1)) + 128), s)
    return s


def step_args(s: str):
    """Argomenti di primo livello di un'istanza STEP (stringhe decodificate, liste come liste, il resto com'e')."""
    out, i, n = [], 0, len(s)
    stack = [out]
    cur = []
    while i < n:
        c = s[i]
        if c == "'":
            j = i + 1
            while j < n:
                if s[j] == "'":
                    if j + 1 < n and s[j + 1] == "'":
                        j += 2
                        continue
                    break
                j += 1
            stack[-1].append(step_str(s[i + 1:j]))
            cur = None
            i = j + 1
            continue
        if c == "(":
            if cur:  # IFCLABEL('x') -> valore tipizzato
                word = "".join(cur).strip()
                lst = []
                stack[-1].append((word, lst))
                stack.append(lst)
            else:
                lst = []
                stack[-1].append(lst)
                stack.append(lst)
            cur = []
            i += 1
            continue
        if c == ")":
            if cur and "".join(cur).strip():
                stack[-1].append("".join(cur).strip())
            cur = []
            if len(stack) > 1:
                stack.pop()
            i += 1
            continue
        if c == ",":
            if cur and "".join(cur).strip():
                stack[-1].append("".join(cur).strip())
            cur = []
            i += 1
            continue
        if cur is None:
            cur = []
        cur.append(c)
        i += 1
    if cur and "".join(cur).strip():
        stack[-1].append("".join(cur).strip())
    return out


def _val(v):
    if isinstance(v, tuple):
        return _val(v[1][0]) if v[1] else ""
    if isinstance(v, list):
        return ", ".join(_val(x) for x in v)
    if v in ("$", "*"):
        return ""
    if v == ".T.":
        return tr("srv_search.vero")
    if v == ".F.":
        return tr("srv_search.falso")
    if isinstance(v, str) and v.startswith(".") and v.endswith("."):
        return v.strip(".")
    return str(v)


_INST = re.compile(r"#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(")
_REFS = re.compile(r"#(\d+)")
_SKIP_IFC = ("IFCCARTESIANPOINT", "IFCPOLYLOOP", "IFCFACE", "IFCDIRECTION", "IFCINDEXEDPOLYGONALFACE", "IFCFACEOUTERBOUND",
             "IFCCARTESIANPOINTLIST3D", "IFCAXIS2PLACEMENT3D", "IFCLOCALPLACEMENT", "IFCPOLYLINE", "IFCSHAPEREPRESENTATION",
             "IFCPRODUCTDEFINITIONSHAPE", "IFCTRIANGULATEDFACESET", "IFCFACEBOUND", "IFCPOLYGONALFACESET", "IFCSTYLEDITEM")
_PROPS = ("IFCPROPERTYSINGLEVALUE", "IFCPROPERTYENUMERATEDVALUE", "IFCQUANTITYLENGTH", "IFCQUANTITYAREA", "IFCQUANTITYVOLUME",
          "IFCQUANTITYCOUNT", "IFCQUANTITYWEIGHT", "IFCQUANTITYTIME", "IFCPROPERTYLISTVALUE", "IFCPROPERTYBOUNDEDVALUE")
_NOT_OBJ = ("IFCREL", "IFCPROPERTYSET", "IFCELEMENTQUANTITY", "IFCOWNERHISTORY")


def _ifc(path, out):
    objs = {}       # id -> [tipo, guid, nome, descr, tipo oggetto, tag]
    props = {}      # id -> "Nome=Valore"
    psets = {}      # id -> (nome, [ids])
    rel_p = {}      # oggetto -> [pset o tipo]
    contained = {}  # oggetto -> struttura spaziale
    mats = {}       # id -> (tipo, args) per materiali e strati
    rel_m = {}      # oggetto -> materiale
    classif = {}    # id riferimento -> testo
    rel_c = {}
    header = []
    buf = ""
    with open(path, "r", encoding="latin-1", errors="replace") as f:
        for line in f:
            if buf:
                buf += line
            else:
                if not line.startswith("#"):
                    if line.startswith(("FILE_NAME", "FILE_DESCRIPTION")):
                        header.append(" ".join(_val(a) for a in step_args(line[line.index("(") + 1:line.rindex(")")]) if _val(a)))
                    continue
                buf = line
            if not buf.rstrip().endswith(";"):
                continue
            s, buf = buf.strip(), ""
            m = _INST.match(s)
            if not m:
                continue
            typ = m.group(2)
            if typ in _SKIP_IFC:
                continue
            iid = int(m.group(1))
            body = s[m.end():s.rindex(")")]
            if typ in _PROPS:
                a = step_args(body)
                if typ.startswith("IFCQUANTITY"):
                    v = _val(a[3]) if len(a) > 3 else ""
                else:
                    v = _val(a[2]) if len(a) > 2 else ""
                props[iid] = f"{_val(a[0])}={v}" if v else _val(a[0])
                continue
            if typ in ("IFCPROPERTYSET", "IFCELEMENTQUANTITY"):
                a = step_args(body)
                k = 5 if typ == "IFCELEMENTQUANTITY" else 4  # IfcElementQuantity ha MethodOfMeasurement prima delle quantita'
                ids = a[k] if len(a) > k and isinstance(a[k], list) else []
                psets[iid] = (_val(a[2]) if len(a) > 2 else "", [int(x[1:]) for x in ids if isinstance(x, str) and x.startswith("#")])
                continue
            if typ == "IFCRELDEFINESBYPROPERTIES" or typ == "IFCRELDEFINESBYTYPE":
                a = step_args(body)
                target = a[5] if len(a) > 5 else None
                if isinstance(target, str) and target.startswith("#"):
                    for o in a[4] if isinstance(a[4], list) else []:
                        if isinstance(o, str) and o.startswith("#"):
                            rel_p.setdefault(int(o[1:]), []).append(int(target[1:]))
                continue
            if typ == "IFCRELCONTAINEDINSPATIALSTRUCTURE" or typ == "IFCRELAGGREGATES":
                a = step_args(body)
                if typ == "IFCRELAGGREGATES":
                    parent, kids = a[4] if len(a) > 4 else None, a[5] if len(a) > 5 else []
                else:
                    kids, parent = a[4] if len(a) > 4 else [], a[5] if len(a) > 5 else None
                if isinstance(parent, str) and parent.startswith("#"):
                    for o in kids if isinstance(kids, list) else []:
                        if isinstance(o, str) and o.startswith("#"):
                            contained.setdefault(int(o[1:]), int(parent[1:]))
                continue
            if typ == "IFCRELASSOCIATESMATERIAL" or typ == "IFCRELASSOCIATESCLASSIFICATION":
                a = step_args(body)
                target = a[5] if len(a) > 5 else None
                if isinstance(target, str) and target.startswith("#"):
                    for o in a[4] if isinstance(a[4], list) else []:
                        if isinstance(o, str) and o.startswith("#"):
                            (rel_m if typ.endswith("MATERIAL") else rel_c).setdefault(int(o[1:]), []).append(int(target[1:]))
                continue
            if typ.startswith("IFCMATERIAL"):
                mats[iid] = (typ, step_args(body))
                continue
            if typ == "IFCCLASSIFICATIONREFERENCE":
                a = step_args(body)
                classif[iid] = " ".join(_val(x) for x in a[:3] if isinstance(x, str) and not x.startswith("#") and _val(x))
                continue
            if typ.startswith(_NOT_OBJ):
                continue
            if body.startswith("'") and len(body) > 24 and body[23] == "'":
                a = step_args(body)
                vals = [_val(x) if isinstance(x, str) and not x.startswith("#") else "" for x in a]
                spatial = typ in ("IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE", "IFCZONE")
                g = lambda k: vals[k] if len(vals) > k else ""  # noqa: E731
                # elementi: indice 7 = Tag; strutture spaziali: indice 7 = nome lungo
                objs[iid] = [typ, g(0), g(2), g(3), g(4), "" if spatial or typ == "IFCPROJECT" else g(7), g(7) if spatial else ""]

    def mat_names(mid, depth=0):
        if depth > 6 or mid not in mats:
            return []
        typ, a = mats[mid]
        if typ == "IFCMATERIAL":
            return [_val(a[0])] if a else []
        res = []
        for x in a:
            for r in (x if isinstance(x, list) else [x]):
                if isinstance(r, str) and r.startswith("#"):
                    res += mat_names(int(r[1:]), depth + 1)
        if typ in ("IFCMATERIALLAYERSET", "IFCMATERIALPROFILESET", "IFCMATERIALCONSTITUENTSET") and len(a) > 1 and isinstance(a[1], str) and _val(a[1]) and not a[1].startswith("#"):
            res.insert(0, _val(a[1]))
        return res

    if header:
        out.meta["intestazione"] = " | ".join(header)[:2000]

    def lines():
        for iid, (typ, guid, name, descr, otype, tag, lname) in objs.items():
            parts = [f"#{iid} {typ}", name, descr, otype, lname, f"{tr('srv_search.ifc_tag')} {tag}" if tag else "", guid]
            where = contained.get(iid)
            if where in objs:
                w = objs[where]
                sp = {"IFCBUILDINGSTOREY": "piano", "IFCBUILDING": "edificio", "IFCSITE": "sito", "IFCSPACE": "locale", "IFCPROJECT": "progetto"}.get(w[0])
                kind = tr("srv_search.ifc_" + sp) if sp else w[0][3:].title()
                parts.append(f"| {kind}: {w[2]}" + (f" ({w[6]})" if w[6] else ""))
            for mid in rel_m.get(iid, []):
                ms = [x for x in dict.fromkeys(mat_names(mid)) if x]
                if ms:
                    parts.append(f"| {tr('srv_search.ifc_materiale')}: " + ", ".join(ms))
            for cid in rel_c.get(iid, []):
                if classif.get(cid):
                    parts.append(f"| {tr('srv_search.ifc_classificazione')}: " + classif[cid])
            for pid in rel_p.get(iid, []):
                if pid in psets:
                    pn, ids = psets[pid]
                    vals = [props[x] for x in ids if x in props]
                    if vals:
                        parts.append(f"| {pn}: " + "; ".join(vals))
                elif pid in objs:  # tipo dell'elemento
                    t = objs[pid]
                    parts.append(f"| {tr('srv_search.ifc_tipo')}: {t[2]} ({t[0]})")
                    for tp in rel_p.get(pid, []):
                        if tp in psets:
                            pn, ids = psets[tp]
                            vals = [props[x] for x in ids if x in props]
                            if vals:
                                parts.append(f"| {pn}: " + "; ".join(vals))
            yield iid, " ".join(p for p in parts if p)
    out.items({}, L("elementi_ifc"), "ifc", lines())


def _step(path, out):
    names = []
    with open(path, "r", encoding="latin-1", errors="replace") as f:
        for i, line in enumerate(f):
            if i > 3_000_000:
                break
            if line.startswith(("FILE_NAME", "FILE_DESCRIPTION")):
                out.meta.setdefault("intestazione", " ".join(_val(a) for a in step_args(line[line.index("(") + 1:line.rindex(")")]) if isinstance(a, str) and _val(a))[:1000])
            elif "=PRODUCT(" in line.replace(" ", ""):
                body = line[line.index("(") + 1:line.rindex(")")]
                a = step_args(body)
                names.append(" ".join(_val(x) for x in a[:3] if isinstance(x, str) and not x.startswith("#") and _val(x)))
    out.add({}, L("parti"), "\n".join(dict.fromkeys(n for n in names if n)))


# ---------------------------------------------------------------- firme, archivi, immagini
def _signed(path, out, tmpdir, depth):
    from . import signed
    data = signed._maybe_base64(Path(path).read_bytes())
    inner = Path(signed._strip_sig_ext(Path(path).name))
    for _ in range(3):  # buste annidate
        ci = signed._looks_signed(data)
        if ci is None:
            break
        c = ci["content"]["encap_content_info"]["content"]
        if c is None or c.native is None:
            out.note = L("nota_firma_separata")
            return
        data = c.native
    ext = inner.suffix.lower().lstrip(".") or signed._guess_ext(data)
    _att_like(data, ext, out, tmpdir, depth, L("documento_firmato"))


def _att_like(data, ext, out, tmpdir, depth, label):
    d = tempfile.mkdtemp(prefix="mbv-idx-", dir=tmpdir)
    p = os.path.join(d, "a." + (ext or "bin"))
    try:
        with open(p, "wb") as f:
            f.write(data)
        sub = extract(p, ext, tmpdir, depth + 1)
        out.meta.update(sub.meta)
        out.note = sub.note
        for loc, lab, text, pos in sub.chunks:
            out.add(loc, L("in", label, lab), text, pos)
    finally:
        try:
            os.remove(p)
            os.rmdir(d)
        except OSError:
            pass


def _archive(path, out, ext):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            names = [i.filename for i in z.infolist()][:50000]
    else:
        from . import archive
        r = archive.list_entries(path)
        names = [i["path"] for i in r.get("items", [])][:50000] if r.get("ok") else []
    out.add({}, L("contenuto_archivio"), "\n".join(names))


def _image(path, out):
    from . import misc
    Image = misc._pil()
    from PIL import ExifTags
    with Image.open(path) as im:
        out.meta["dimensioni"] = f"{im.width} x {im.height} px"
        lines = []
        for k, v in (getattr(im, "text", None) or im.info or {}).items():
            if isinstance(v, str) and k not in ("icc_profile", "exif") and len(v) < 5000:
                lines.append(f"{k}: {v}")
        try:
            ex = im.getexif()
        except Exception:  # noqa: BLE001
            ex = {}

        def put(tags, names):
            for k, v in tags.items():
                n = names.get(k, str(k))
                if isinstance(v, bytes):
                    if n.startswith("XP"):
                        v = v.decode("utf-16-le", "ignore").rstrip("\x00")
                    elif n == "UserComment":
                        v = v[8:].decode("utf-16-le" if v[:8].startswith(b"UNICODE") else "latin-1", "ignore").rstrip("\x00")
                    else:
                        continue
                if n in ("MakerNote", "PrintImageMatching", "ExifOffset", "GPSInfo", "JPEGInterchangeFormat", "JPEGInterchangeFormatLength", "StripOffsets", "StripByteCounts"):
                    continue
                s = str(v)
                if len(s) < 500:
                    lines.append(f"{n}: {s}")
        if ex:
            put(ex, ExifTags.TAGS)
            for ifd, names in ((ExifTags.IFD.Exif, ExifTags.TAGS), (ExifTags.IFD.GPSInfo, ExifTags.GPSTAGS)):
                try:
                    put(ex.get_ifd(ifd), names)
                except Exception:  # noqa: BLE001
                    pass
            for k, lab in ((0x010F, "fotocamera"), (0x0110, "modello"), (0x013B, "autore"), (0x8298, "copyright"), (0x010E, "descrizione")):
                if ex.get(k):
                    out.meta[lab] = str(ex.get(k)).strip("\x00 ")
        xmp = im.info.get("xmp") or im.info.get("XML:com.adobe.xmp")
        if xmp:
            x = xmp.decode("utf-8", "ignore") if isinstance(xmp, bytes) else str(xmp)
            words = re.findall(r"<rdf:li[^>]*>([^<]+)</rdf:li>", x)
            if words:
                lines.append("XMP: " + "; ".join(words[:200]))
        out.add({}, L("metadati"), "\n".join(lines))
