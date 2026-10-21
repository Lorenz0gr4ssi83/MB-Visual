"""Pubblicazioni (editor in stile Publisher, ui/js/pubedit.js).

- export_pdf: scrive il PDF dalle operazioni di disegno registrate dall'interfaccia (ui/js/pubexport.js): percorsi
  vettoriali, testo vero con i caratteri di Windows incorporati (ridotti ai caratteri usati), immagini, collegamenti.
  Coordinate in punti con origine in alto a sinistra (le stesse di PyMuPDF).
- import_pub: apertura dei file di Microsoft Publisher (.pub). Con Publisher installato si legge tutta
  l'impaginazione tramite COM (pagine, caselle di testo collegate, forme, tabelle, immagini; il resto come immagine);
  senza Publisher si estraggono dal file OLE solo il testo e le immagini (il formato dell'impaginazione e' chiuso).
"""
import json
import math
import os
import re
import struct
import uuid
from pathlib import Path

import pymupdf

from .paths import TEMP_DIR
from .i18n import t as _t

FONTS_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
_FONT_IDX = None


# ------------------------------------------------------------------ caratteri di Windows
def _font_index() -> dict:
    """famiglia (minuscolo) -> {(grassetto, corsivo): file} dal registro dei caratteri di Windows."""
    global _FONT_IDX
    if _FONT_IDX is not None:
        return _FONT_IDX
    idx: dict = {}
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                k = winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")
            except OSError:
                continue
            i = 0
            while True:
                try:
                    name, data, _ = winreg.EnumValue(k, i)
                except OSError:
                    break
                i += 1
                f = Path(data)
                if not f.is_absolute():
                    f = FONTS_DIR / data
                if f.suffix.lower() not in (".ttf", ".otf", ".ttc") or not f.exists():
                    continue
                name = re.sub(r"\s*\((TrueType|OpenType)\)\s*$", "", name, flags=re.I)
                first = name.split(" & ")[0].strip()  # nei .ttc vale solo la prima famiglia (indice 0)
                m = re.match(r"^(.*?)(?:\s+(Bold Italic|Bold Oblique|Bold|Italic|Oblique|Regular))?$", first)
                fam, st = m.group(1).strip().lower(), (m.group(2) or "").lower()
                key = ("bold" in st, "italic" in st or "oblique" in st)
                idx.setdefault(fam, {}).setdefault(key, str(f))
    except Exception:  # noqa: BLE001
        pass
    _FONT_IDX = idx
    return idx


def _font_file(family: str, bold: bool, italic: bool):
    """(file, grassetto simulato, corsivo simulato)."""
    idx = _font_index()
    words = (family or "Arial").split()
    while words:
        fam = " ".join(words).lower()
        if fam in idx:
            files = idx[fam]
            for key in ((bold, italic), (bold, False), (False, italic), (False, False)):
                if key in files:
                    return files[key], bold and not key[0], italic and not key[1]
            f = next(iter(files.values()))
            return f, bold, italic
        words = words[:-1]
    try:
        from .pdfedit import _font_file as fb
        f = fb(family, bold, italic)
        if f:
            return str(f), False, False
    except Exception:  # noqa: BLE001
        pass
    return None, bold, italic


def _rgb(c):
    if not c:
        return None
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(x * 2 for x in c)
    return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))


# ------------------------------------------------------------------ PDF
def export_pdf(body: bytes, out: str) -> dict:
    if body[:6] != b"MBPUB1":
        raise ValueError(_t("srv_publisher.dati_pubblicazione_non_validi"))
    n = struct.unpack_from("<I", body, 6)[0]
    spec = json.loads(body[10:10 + n].decode("utf-8"))
    base = 10 + n
    blobs = {k: body[base + o: base + o + ln] for k, (o, ln) in spec.get("blobs", {}).items()}
    doc = pymupdf.open()
    aliases: dict = {}
    for pg in spec["pages"]:
        page = doc.new_page(width=pg["w"], height=pg["h"])
        for op in pg["ops"]:
            t = op.get("t")
            try:
                if t == "path":
                    _path(page, op)
                elif t == "text":
                    _text(page, op, aliases)
                elif t == "image":
                    _image(page, op, blobs.get(op["key"]))
                elif t == "link":
                    page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(op["r"]), "uri": op["uri"]})
            except Exception as e:  # noqa: BLE001  (un oggetto difettoso non ferma il PDF)
                print("publisher.export_pdf:", t, e)
    try:
        doc.subset_fonts()
    except Exception:  # noqa: BLE001
        pass
    doc.set_metadata({"title": spec.get("title") or Path(out).stem, "producer": "MB Visual", "creator": "MB Visual - Pubblicazioni"})
    tmp = out + ".mbv-tmp"
    doc.save(tmp, garbage=3, deflate=True)
    doc.close()
    os.replace(tmp, out)
    return {"ok": True, "path": out, "pagine": len(spec["pages"])}


def _path(page, op):
    sh = page.new_shape()
    cur = start = None
    drawn = False
    for c in op["d"]:
        k = c[0]
        if k == "M":
            cur = start = pymupdf.Point(c[1], c[2])
        elif k == "L" and cur is not None:
            p = pymupdf.Point(c[1], c[2])
            sh.draw_line(cur, p)
            cur = p
            drawn = True
        elif k == "C" and cur is not None:
            p = pymupdf.Point(c[5], c[6])
            sh.draw_bezier(cur, pymupdf.Point(c[1], c[2]), pymupdf.Point(c[3], c[4]), p)
            cur = p
            drawn = True
        elif k == "Z" and cur is not None and start is not None:
            if abs(cur.x - start.x) > 1e-6 or abs(cur.y - start.y) > 1e-6:
                sh.draw_line(cur, start)
                drawn = True
            cur = start
    if not drawn:
        return
    stroke, fill = _rgb(op.get("stroke")), _rgb(op.get("fill"))
    dash = op.get("dash")
    joins = {"miter": 0, "round": 1, "bevel": 2}
    caps = {"butt": 0, "round": 1, "square": 2}
    sh.finish(color=stroke, fill=fill, width=op.get("sw") or 0 if stroke else 0,
              dashes="[" + " ".join(f"{v:.2f}" for v in dash) + "] 0" if dash and stroke else None,
              even_odd=bool(op.get("evenodd")), closePath=False,
              lineJoin=joins.get(op.get("join"), 0), lineCap=caps.get(op.get("cap"), 0),
              fill_opacity=op.get("op", 1), stroke_opacity=op.get("op", 1))
    sh.commit()


def _text(page, op, aliases):
    f, fake_b, fake_i = _font_file(op.get("font"), op.get("b"), op.get("i"))
    a, b, c, d = op.get("m") or (1, 0, 0, 1)
    # la matrice arriva in coordinate con y verso il basso; morph di PyMuPDF lavora con y verso l'alto: b e c cambiano segno (sotto)
    if fake_i:  # corsivo simulato: inclinazione
        a, b, c, d = a, b, c - 0.21 * a, d - 0.21 * b
    p = pymupdf.Point(*op["p"])
    fill, stroke = _rgb(op.get("fill")), _rgb(op.get("stroke"))
    size = op["size"]
    sw = op.get("sw") or 0
    mode = 0
    color = fill
    if stroke and fill:
        mode, color = 2, stroke
    elif stroke:
        mode, color = 1, stroke
    elif fake_b:
        mode, stroke, sw = 2, fill, size * 0.055
        color = fill
    kw = {}
    if f:
        alias = aliases.setdefault(f, "MBF%d" % len(aliases))
        kw = {"fontname": alias, "fontfile": f}
    else:
        kw = {"fontname": "hebo" if op.get("b") else "helv"}
    ident = abs(a - 1) < 1e-6 and abs(b) < 1e-6 and abs(c) < 1e-6 and abs(d - 1) < 1e-6
    page.insert_text(p, op["str"], fontsize=size, color=color, fill=fill if mode == 2 else None, render_mode=mode,
                     border_width=(sw / size) if mode else 0.05, morph=None if ident else (p, pymupdf.Matrix(a, -b, -c, d, 0, 0)),
                     fill_opacity=op.get("op", 1), stroke_opacity=op.get("op", 1), **kw)


def _image(page, op, data):
    if not data:
        return
    cx, cy = op["c"]
    w, h, ang = op["w"], op["h"], op.get("a", 0) or 0
    ang = ((ang + 180) % 360) - 180
    if abs(ang) < 0.01:
        page.insert_image(pymupdf.Rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), stream=data, keep_proportion=False)
        return
    # immagine ruotata: pagina temporanea con l'immagine, mostrata ruotata nel riquadro che la contiene
    src = pymupdf.open()
    sp = src.new_page(width=w, height=h)
    sp.insert_image(sp.rect, stream=data, keep_proportion=False)
    r = math.radians(ang)
    bw = abs(w * math.cos(r)) + abs(h * math.sin(r))
    bh = abs(w * math.sin(r)) + abs(h * math.cos(r))
    page.show_pdf_page(pymupdf.Rect(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2), src, 0, rotate=-ang, keep_proportion=True)
    src.close()


# ------------------------------------------------------------------ apertura dei .pub
def import_pub(path: str, update=None) -> dict:
    from .paths import find_office
    if find_office("mspub.exe"):
        try:
            return _import_com(path, update)
        except Exception as e:  # noqa: BLE001
            r = _import_ole(path)
            r["nota"] = _t("srv_publisher.publisher_non_ha_potuto_aprire", e)
            return r
    return _import_ole(path)


def _bgr(v):
    try:
        v = int(v)
        return "#%02x%02x%02x" % (v & 255, (v >> 8) & 255, (v >> 16) & 255)
    except Exception:  # noqa: BLE001
        return None


AUTOSHAPES = {1: "rect", 5: "round", 9: "ellipse", 7: "triangle", 8: "rtriangle", 4: "diamond", 2: "parallelogram", 3: "trapezoid",
              10: "hexagon", 6: "octagon", 11: "cross", 51: "pentagon", 33: "arrowR", 34: "arrowL", 35: "arrowU", 36: "arrowD",
              52: "chevron", 92: "star5", 93: "star8", 94: "star16", 21: "heart", 24: "moon", 18: "donut", 105: "callout"}
ALIGN = {1: "l", 2: "c", 3: "r", 4: "j", 5: "j"}


def _import_com(path: str, update=None) -> dict:
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    out_dir = TEMP_DIR / "pub-import" / uuid.uuid4().hex[:8]
    out_dir.mkdir(parents=True, exist_ok=True)
    app = win32com.client.Dispatch("Publisher.Application")
    pdoc = None
    try:
        pdoc = app.Open(str(Path(path).resolve()), True, False, 3)
        try:
            app.ActiveWindow.Visible = False
        except Exception:  # noqa: BLE001
            pass
        W, H = float(pdoc.PageSetup.PageWidth), float(pdoc.PageSetup.PageHeight)
        images = {}
        counter = [0]

        def picture(s, x, y, w, h, rot):
            counter[0] += 1
            f = out_dir / f"img{counter[0]}.png"
            try:
                try:
                    s.SaveAsPicture(str(f), 300)
                except Exception:  # noqa: BLE001
                    s.SaveAsPicture(str(f))
            except Exception:  # noqa: BLE001
                return None
            if not f.exists():
                return None
            iid = f"i{counter[0]}"
            images[iid] = str(f)
            # SaveAsPicture salva l'oggetto gia' ruotato: si inserisce nel riquadro che lo contiene
            return {"type": "image", "x": x, "y": y, "w": w, "h": h, "rot": 0, "imgFile": iid}

        def paras_of(tr):
            out = []
            try:
                n = int(tr.ParagraphsCount)
            except Exception:  # noqa: BLE001
                n = 0
            for i in range(1, n + 1):
                p = tr.Paragraphs(i, 1)
                pf = p.ParagraphFormat
                para = {"a": ALIGN.get(int(pf.Alignment), "l"), "sb": float(pf.SpaceBefore or 0), "sa": float(pf.SpaceAfter or 0), "runs": []}
                fnt = p.Font
                mixed = any(int(v) == -2 for v in (fnt.Bold, fnt.Italic)) or fnt.Name in ("", None) or float(fnt.Size or 0) <= 0
                pieces = []
                if mixed:
                    try:
                        for k in range(1, int(p.WordsCount) + 1):
                            pieces.append(p.Words(k, 1))
                    except Exception:  # noqa: BLE001
                        pieces = [p]
                else:
                    pieces = [p]
                for w in pieces:
                    t = str(w.Text or "").replace("\r", "").replace("\x0b", "\n")
                    if not t:
                        continue
                    f = w.Font
                    para["runs"].append({"t": t, "f": str(f.Name or "Arial"), "z": float(f.Size or 10) if float(f.Size or 0) > 0 else 10,
                                         "b": int(f.Bold) == -1, "i": int(f.Italic) == -1, "u": int(f.Underline or 0) > 0,
                                         "c": _bgr(f.Color.RGB) or "#000000"})
                out.append(para)
            return out

        def shape_item(s):
            x, y, w, h = float(s.Left), float(s.Top), float(s.Width), float(s.Height)
            rot = float(getattr(s, "Rotation", 0) or 0)
            typ = int(s.Type)
            base = {"x": x, "y": y, "w": w, "h": h, "rot": rot}
            fill = line = None
            try:
                if int(s.Fill.Visible) == -1:
                    fill = _bgr(s.Fill.ForeColor.RGB)
            except Exception:  # noqa: BLE001
                pass
            try:
                if int(s.Line.Visible) == -1:
                    line = {"c": _bgr(s.Line.ForeColor.RGB), "w": float(s.Line.Weight)}
            except Exception:  # noqa: BLE001
                pass
            if typ == 6:  # gruppo
                kids = [it for it in (shape_item(s.GroupItems(k)) for k in range(1, s.GroupItems.Count + 1)) if it]
                return {"type": "group", "items": kids} if kids else None
            try:
                if int(s.HasTable) == -1:
                    tb = s.Table
                    R, C = int(tb.Rows.Count), int(tb.Columns.Count)
                    cells = [[paras_of(tb.Cell(r, c).TextRange) for c in range(1, C + 1)] for r in range(1, R + 1)]
                    return {**base, "type": "table", "rows": R, "cols": C, "colW": [float(tb.Columns(c).Width) for c in range(1, C + 1)],
                            "rowH": [float(tb.Rows(r).Height) for r in range(1, R + 1)], "cellParas": cells}
            except Exception:  # noqa: BLE001
                pass
            if typ == 15:  # WordArt
                try:
                    te = s.TextEffect
                    return {**base, "type": "wordart", "text": str(te.Text), "font": str(te.FontName), "b": int(te.FontBold) == -1, "i": int(te.FontItalic) == -1, "fill": fill or "#000000"}
                except Exception:  # noqa: BLE001
                    return picture(s, x, y, w, h, rot)
            if typ == 9:  # linea
                return {**base, "type": "shape", "shape": "line", "line": line or {"c": "#000000", "w": 1}, "flipV": (int(s.HorizontalFlip) == -1) != (int(s.VerticalFlip) == -1), "fill": "none"}
            has_text = False
            try:
                has_text = int(s.HasTextFrame) == -1
            except Exception:  # noqa: BLE001
                pass
            if has_text and typ in (17, 1) and (typ == 17 or AUTOSHAPES.get(int(s.AutoShapeType)) == "rect"):
                tf = s.TextFrame
                item = {**base, "type": "text", "fill": fill or "none", "line": line, "pid": int(s.ID)}
                try:
                    item["pad"] = [float(tf.MarginLeft), float(tf.MarginTop), float(tf.MarginRight), float(tf.MarginBottom)]
                    item["cols"] = int(tf.Columns.Count) if hasattr(tf, "Columns") else 1
                except Exception:  # noqa: BLE001
                    pass
                prev = nxt = False
                try:
                    prev, nxt = int(tf.HasPreviousLink) == -1, int(tf.HasNextLink) == -1
                except Exception:  # noqa: BLE001
                    pass
                if nxt:
                    try:
                        item["nextPid"] = int(tf.NextLinkedTextFrame.Parent.ID)
                    except Exception:  # noqa: BLE001
                        pass
                if not prev:
                    tr = tf.Story.TextRange if nxt else tf.TextRange
                    item["paras"] = paras_of(tr)
                try:
                    item["valign"] = {1: "t", 2: "m", 3: "b"}.get(int(tf.VerticalTextAlignment), "t")
                except Exception:  # noqa: BLE001
                    pass
                return item
            if typ == 1:
                shp = AUTOSHAPES.get(int(s.AutoShapeType))
                words = False
                try:
                    words = has_text and int(s.TextFrame.HasText) == -1
                except Exception:  # noqa: BLE001
                    pass
                if shp and not words:
                    return {**base, "type": "shape", "shape": shp, "fill": fill or "none", "line": line}
            return picture(s, x, y, w, h, rot)

        def page_items(pg):
            out = []
            for k in range(1, pg.Shapes.Count + 1):
                try:
                    it = shape_item(pg.Shapes(k))
                except Exception as e:  # noqa: BLE001
                    print("pub_import:", e)
                    it = None
                if it:
                    out.append(it)
            return out

        masters = []
        try:
            for k in range(1, pdoc.MasterPages.Count + 1):
                masters.append({"items": page_items(pdoc.MasterPages(k))})
        except Exception:  # noqa: BLE001
            pass
        pages = []
        n = pdoc.Pages.Count
        for k in range(1, n + 1):
            if update:
                update(k / (n + 1), _t("srv_publisher.pagina_0_1", k, n))
            pg = pdoc.Pages(k)
            pages.append({"items": page_items(pg)})
        return {"ok": True, "mode": "publisher", "w": W, "h": H, "pages": pages, "masters": masters[:1], "images": images}
    finally:
        try:
            if pdoc is not None:
                pdoc.Close()
        except Exception:  # noqa: BLE001
            pass
        try:
            if app.Documents.Count == 0:
                app.Quit()
        except Exception:  # noqa: BLE001
            pass


def _import_ole(path: str) -> dict:
    """Senza Publisher: testo (flusso Quill/QuillSub/CONTENTS, UTF-16) e immagini JPEG/PNG contenute nel file."""
    import olefile
    out_dir = TEMP_DIR / "pub-import" / uuid.uuid4().hex[:8]
    out_dir.mkdir(parents=True, exist_ok=True)
    ole = olefile.OleFileIO(path)
    text = ""
    try:
        if ole.exists("Quill/QuillSub/CONTENTS"):
            data = ole.openstream("Quill/QuillSub/CONTENTS").read()
            text = _quill_text(data)
        images = {}
        n = 0
        for entry in ole.listdir():
            data = ole.openstream(entry).read()
            for blob in _find_images(data):
                n += 1
                ext = "jpg" if blob[:2] == b"\xff\xd8" else "png"
                f = out_dir / f"img{n}.{ext}"
                f.write_bytes(blob)
                images[f"i{n}"] = str(f)
    finally:
        ole.close()
    paras = [{"a": "l", "runs": [{"t": p, "f": "Calibri", "z": 11}]} for p in text.split("\r") if p.strip()]
    W, H = 595.28, 841.89
    items = [{"type": "text", "x": 36, "y": 36, "w": W - 72, "h": H - 72, "paras": paras or [{"runs": [{"t": "", "z": 11}]}], "pid": 1}]
    pages = [{"items": items}]
    for k, iid in enumerate(images):
        pages.append({"items": [{"type": "image", "x": 36, "y": 36, "w": W - 72, "h": (H - 72) / 2, "rot": 0, "imgFile": iid, "fit": True}]})
    return {"ok": True, "mode": "testo", "w": W, "h": H, "pages": pages, "masters": [], "images": images,
            "nota": _t("srv_publisher.publisher_non_installato_file_pub")}


def _quill_text(data: bytes) -> str:
    # il blocco TEXT contiene il testo della pubblicazione in UTF-16LE; si cercano le sequenze leggibili
    runs = []
    for off in (0, 1):
        t = data[off:].decode("utf-16-le", errors="ignore")
        for m in re.finditer(r"[\u0020-\u024f\u2010-\u2027\u2030-\u205e\u20ac\r\n\t\x0b]{3,}", t):
            seg = m.group(0)
            if sum(ch.isalpha() for ch in seg) >= max(2, len(seg) // 3):
                runs.append(seg)
    best = "\r".join(runs)
    return best.replace("\x0b", "\n")


def _find_images(data: bytes):
    pos = 0
    while True:
        j = data.find(b"\xff\xd8\xff", pos)
        p = data.find(b"\x89PNG\r\n\x1a\n", pos)
        cands = [x for x in (j, p) if x >= 0]
        if not cands:
            return
        k = min(cands)
        if k == p:
            e = data.find(b"IEND", k)
            if e < 0:
                return
            yield data[k:e + 8]
            pos = e + 8
        else:
            e = data.find(b"\xff\xd9", k + 3)
            while e >= 0 and e - k < 2000:
                e = data.find(b"\xff\xd9", e + 2)
            if e < 0:
                return
            yield data[k:e + 2]
            pos = e + 2
