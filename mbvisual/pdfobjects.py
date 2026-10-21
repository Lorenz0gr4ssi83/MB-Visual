"""Editor PDF avanzato (PyMuPDF): oggetti della pagina e operazioni di modifica.

Oggetti: immagini, blocchi di testo, disegni vettoriali, campi modulo, collegamenti.
Operazioni (applicate in ordine alla copia di lavoro): testo a blocchi, macchina da scrivere, immagini (inserisci, sposta,
ridimensiona, sostituisci, elimina), disegni (sposta, elimina), forme, campi modulo (crea, modifica, elimina),
collegamenti, oscura / bianchetto, e operazioni sul documento (proprieta', segnalibri, pagine, ritaglio, appiattimento).
Coordinate scambiate con l'interfaccia: spazio PDF (origine in basso a sinistra), come pdf.js.
"""
import base64
import os

import pymupdf

from .pdfedit import _font, _from_pdf, _insert_text, _to_pdf

WIDGET_TYPES = {
    "text": pymupdf.PDF_WIDGET_TYPE_TEXT, "combo": pymupdf.PDF_WIDGET_TYPE_COMBOBOX, "list": pymupdf.PDF_WIDGET_TYPE_LISTBOX,
    "check": pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "radio": pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON, "signature": pymupdf.PDF_WIDGET_TYPE_SIGNATURE,
}
TYPE_NAMES = {v: k for k, v in WIDGET_TYPES.items()}


def _rgb(c, default=(0, 0, 0)):
    if c in (None, "", "none"):
        return None if default is None else default
    c = str(c).lstrip("#").ljust(6, "0")
    return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _hex(c):
    if c is None:
        return None
    if isinstance(c, (list, tuple)) and len(c) >= 3:
        return "#%02x%02x%02x" % tuple(max(0, min(255, round(v * 255))) for v in c[:3])
    if isinstance(c, int):
        return f"#{c:06x}"
    return None


# ---------------------------------------------------------------- lettura degli oggetti di una pagina
def page_objects(path: str, pno: int) -> dict:
    with pymupdf.open(path) as doc:
        page = doc[pno]
        out = []
        for info in page.get_image_info(xrefs=True):
            if (info.get("width") or 0) <= 1 and (info.get("height") or 0) <= 1:
                continue  # immagine eliminata (segnaposto trasparente lasciato da PyMuPDF)
            out.append({"kind": "image", "xref": info.get("xref", 0), "box": _to_pdf(page, info["bbox"]),
                        "px": [info.get("width"), info.get("height")], "movable": bool(info.get("xref"))})
        for b in page.get_text("dict")["blocks"]:
            if b.get("type") != 0:
                continue
            lines, first = [], None
            for ln in b["lines"]:
                t = "".join(s["text"] for s in ln["spans"]).rstrip()
                if t.strip():
                    lines.append(t)
                    first = first or next((s for s in ln["spans"] if s["text"].strip()), None)
            if not lines or not first:
                continue
            out.append({"kind": "text", "box": _to_pdf(page, b["bbox"]), "text": "\n".join(lines), "font": first["font"],
                        "size": round(first["size"], 2), "color": _hex(first["color"]),
                        "bold": bool(first["flags"] & 16) or "bold" in first["font"].lower(),
                        "italic": bool(first["flags"] & 2) or "italic" in first["font"].lower()})
        draws = page.get_drawings()
        for d in draws[:4000]:
            r = pymupdf.Rect(d["rect"])
            if r.is_empty and r.width == 0 and r.height == 0:
                continue
            out.append({"kind": "drawing", "box": _to_pdf(page, r), "stroke": _hex(d.get("color")), "fill": _hex(d.get("fill")),
                        "width": d.get("width") or 0})
        for w in page.widgets():
            out.append({"kind": "field", "xref": w.xref, "name": w.field_name, "type": TYPE_NAMES.get(w.field_type, "text"),
                        "label": w.field_type_string, "box": _to_pdf(page, w.rect), "value": w.field_value,
                        "options": list(w.choice_values or []), "fontsize": w.text_fontsize, "flags": w.field_flags,
                        "multiline": bool(w.field_flags & pymupdf.PDF_TX_FIELD_IS_MULTILINE) if w.field_type == pymupdf.PDF_WIDGET_TYPE_TEXT else False,
                        "required": bool(w.field_flags & pymupdf.PDF_FIELD_IS_REQUIRED), "readonly": bool(w.field_flags & pymupdf.PDF_FIELD_IS_READ_ONLY),
                        "tooltip": w.field_label or ""})
        for ln in page.get_links():
            out.append({"kind": "link", "box": _to_pdf(page, ln["from"]), "uri": ln.get("uri") or "", "page": ln.get("page", -1)})
        meta = doc.metadata or {}
        return {"ok": True, "oggetti": out, "pagine": len(doc), "metadata": {k: meta.get(k, "") for k in ("title", "author", "subject", "keywords")},
                "toc": doc.get_toc(simple=True), "size": [page.rect.width, page.rect.height]}


# ---------------------------------------------------------------- utilita'
def _image_bytes(doc, xref):
    """Immagine con l'eventuale trasparenza (soft mask), in PNG."""
    info = doc.extract_image(xref)
    if info.get("smask"):
        base = pymupdf.Pixmap(doc, xref)
        mask = pymupdf.Pixmap(doc, info["smask"])
        try:
            return pymupdf.Pixmap(base, mask).tobytes("png")
        except Exception:  # noqa: BLE001
            pass
    return info["image"]


def _redact(page, rect, text=True, images=False, graphics=False, fill=None):
    page.add_redact_annot(rect, fill=fill)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS if images else pymupdf.PDF_REDACT_IMAGE_NONE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED if graphics else pymupdf.PDF_REDACT_LINE_ART_NONE,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE if text else pymupdf.PDF_REDACT_TEXT_NONE)


def _draw_paths(page, paths, dx=0.0, dy=0.0, sx=1.0, sy=1.0, ox=0.0, oy=0.0):
    """Ridisegna percorsi vettoriali (da get_drawings) traslati/scalati attorno a (ox, oy)."""
    T = lambda p: pymupdf.Point(ox + (p.x - ox) * sx + dx, oy + (p.y - oy) * sy + dy)  # noqa: E731
    shape = page.new_shape()
    for path in paths:
        for it in path["items"]:
            op = it[0]
            if op == "l":
                shape.draw_line(T(it[1]), T(it[2]))
            elif op == "c":
                shape.draw_bezier(T(it[1]), T(it[2]), T(it[3]), T(it[4]))
            elif op == "re":
                r = it[1]
                shape.draw_rect(pymupdf.Rect(T(r.tl), T(r.br)))
            elif op == "qu":
                q = it[1]
                shape.draw_quad(pymupdf.Quad(T(q.ul), T(q.ur), T(q.ll), T(q.lr)))
        shape.finish(color=path.get("color"), fill=path.get("fill"), width=(path.get("width") or 1) * (sx + sy) / 2,
                     closePath=path.get("closePath", False), even_odd=path.get("even_odd", False),
                     lineCap=max(path.get("lineCap") or [0]) if isinstance(path.get("lineCap"), (list, tuple)) else (path.get("lineCap") or 0),
                     lineJoin=path.get("lineJoin") or 0, dashes=path.get("dashes") or None,
                     fill_opacity=path.get("fill_opacity") if path.get("fill_opacity") is not None else 1,
                     stroke_opacity=path.get("stroke_opacity") if path.get("stroke_opacity") is not None else 1)
    shape.commit()


def _paths_in(page, rect, tol=0.6):
    big = rect + (-tol, -tol, tol, tol)
    return [p for p in page.get_drawings() if pymupdf.Rect(p["rect"]) in big]


def _find_widget(page, xref):
    for w in page.widgets():
        if w.xref == int(xref):
            return w
    return None


def _pdf_str(s) -> str:
    return "(" + str(s).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def _sync_field(doc, w, o):
    """PyMuPDF scrive nome, flag e voci sul widget; se il campo ha un genitore (/Parent con /T) i dati veri stanno li':
    si riscrivono direttamente nel dizionario del campo."""
    fx = w.xref
    par = doc.xref_get_key(w.xref, "Parent")
    if par[0] == "xref":
        fx = int(par[1].split()[0])
        if o.get("name"):
            doc.xref_set_key(fx, "T", _pdf_str(o["name"]))
        if "tooltip" in o:
            doc.xref_set_key(fx, "TU", _pdf_str(o["tooltip"]) if o["tooltip"] else "null")
        doc.xref_set_key(fx, "Ff", str(w.field_flags or 0))
        for k in ("T", "Ff", "Opt", "TU", "FT"):  # niente doppioni sul widget figlio
            if k != "FT" and doc.xref_get_key(w.xref, k)[0] != "null":
                doc.xref_set_key(w.xref, k, "null")
    if o.get("options") is not None and w.field_type in (pymupdf.PDF_WIDGET_TYPE_COMBOBOX, pymupdf.PDF_WIDGET_TYPE_LISTBOX):
        opts = [s for s in o["options"] if str(s).strip()]
        doc.xref_set_key(fx, "Opt", "[" + " ".join(_pdf_str(s) for s in opts) + "]")
        cur = doc.xref_get_key(fx, "V")
        if cur[0] == "string" and cur[1] not in opts:
            doc.xref_set_key(fx, "V", "null")
    if "value" in o and fx != w.xref and w.field_type not in (pymupdf.PDF_WIDGET_TYPE_CHECKBOX, pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON, pymupdf.PDF_WIDGET_TYPE_SIGNATURE):
        doc.xref_set_key(fx, "V", _pdf_str(o["value"]) if o["value"] else "null")


def _set_widget(w, o):
    if "name" in o and o["name"]:
        w.field_name = o["name"]
    if "tooltip" in o:
        w.field_label = o["tooltip"] or None
    if "options" in o and w.field_type in (pymupdf.PDF_WIDGET_TYPE_COMBOBOX, pymupdf.PDF_WIDGET_TYPE_LISTBOX):
        w.choice_values = [s for s in o["options"] if str(s).strip()]
    if "fontsize" in o and o["fontsize"] is not None:
        w.text_fontsize = float(o["fontsize"])
    flags = w.field_flags or 0
    for key, bit in (("required", pymupdf.PDF_FIELD_IS_REQUIRED), ("readonly", pymupdf.PDF_FIELD_IS_READ_ONLY)):
        if key in o:
            flags = flags | bit if o[key] else flags & ~bit
    if "multiline" in o and w.field_type == pymupdf.PDF_WIDGET_TYPE_TEXT:
        flags = flags | pymupdf.PDF_TX_FIELD_IS_MULTILINE if o["multiline"] else flags & ~pymupdf.PDF_TX_FIELD_IS_MULTILINE
    if w.field_type == pymupdf.PDF_WIDGET_TYPE_COMBOBOX and "editable" in o:
        flags = flags | pymupdf.PDF_CH_FIELD_IS_EDIT if o["editable"] else flags & ~pymupdf.PDF_CH_FIELD_IS_EDIT
    w.field_flags = flags
    if "value" in o:
        v = o["value"]
        if w.field_type == pymupdf.PDF_WIDGET_TYPE_CHECKBOX:
            w.field_value = w.on_state() if v in (True, "true", "Si'", "Yes", "On", 1, "1") else "Off"
        elif w.field_type != pymupdf.PDF_WIDGET_TYPE_SIGNATURE:
            w.field_value = v if v is not None else ""
    if o.get("border"):
        w.border_color = _rgb(o["border"])
    if "fill" in o:
        w.fill_color = _rgb(o["fill"], None)
    if o.get("textcolor"):
        w.text_color = _rgb(o["textcolor"])


# ---------------------------------------------------------------- operazioni
def apply_ops(path: str, ops: list[dict]) -> dict:
    tmp = path + ".mbv-ops.pdf"
    done = 0
    with pymupdf.open(path) as doc:
        for o in ops:
            k = o["kind"]
            page = doc[int(o["page"])] if "page" in o and o["page"] is not None and k not in ("page_delete", "page_move") else None
            r = _from_pdf(page, o["box"]) if page is not None and o.get("box") else None
            to = _from_pdf(page, o["to"]) if page is not None and o.get("to") else None

            if k == "text_block":
                # blocco di testo riscritto (anche su piu' righe, con a capo automatico) nello stesso posto o spostato
                _redact(page, r + (-0.5, -0.5, 0.5, 0.5), text=True)
                dest = to or r
                f = _font(o.get("font", ""), bool(o.get("bold")), bool(o.get("italic")))
                tw = pymupdf.TextWriter(page.rect, color=_rgb(o.get("color")))
                size = float(o.get("size") or 11)
                box = pymupdf.Rect(dest.x0, dest.y0, max(dest.x1, dest.x0 + 20), page.rect.y1)
                tw.fill_textbox(box, o.get("text", ""), font=f, fontsize=size, align=int(o.get("align", 0)), lineheight=float(o.get("lineheight", 1.15)))
                tw.write_text(page)
            elif k == "typewriter":
                # macchina da scrivere: testo vero nella pagina, dal punto cliccato
                p = pymupdf.Point(o["at"][0], o["at"][1]) * page.transformation_matrix
                _insert_text(page, pymupdf.Rect(p.x, p.y, p.x + 10, p.y + 10), o.get("text", ""), o.get("font", "Helvetica"), float(o.get("size") or 11),
                             o.get("color") or "#000000", bool(o.get("bold")), bool(o.get("italic")), 0, p)
            elif k == "image_add":
                data = base64.b64decode(o["data"])
                page.insert_image(r, stream=data, keep_proportion=bool(o.get("keep", True)), rotate=int(o.get("rotate", 0)))
            elif k == "image_move":
                xref = int(o["xref"])
                data = _image_bytes(doc, xref)
                page.delete_image(xref)
                page.insert_image(to, stream=data, keep_proportion=False)
            elif k == "image_replace":
                page.replace_image(int(o["xref"]), stream=base64.b64decode(o["data"]))
            elif k == "image_delete":
                page.delete_image(int(o["xref"]))
            elif k in ("draw_move", "draw_delete"):
                paths = _paths_in(page, r)
                _redact(page, r + (-0.6, -0.6, 0.6, 0.6), text=False, images=False, graphics=True)
                if k == "draw_move" and paths:
                    sx = to.width / r.width if r.width else 1
                    sy = to.height / r.height if r.height else 1
                    _draw_paths(page, paths, to.x0 - r.x0, to.y0 - r.y0, sx, sy, r.x0, r.y0)
            elif k == "shape":
                shp = page.new_shape()
                kind = o.get("shape", "rect")
                if kind in ("line", "arrow"):
                    a = pymupdf.Point(o["p1"]) * page.transformation_matrix
                    b = pymupdf.Point(o["p2"]) * page.transformation_matrix
                    shp.draw_line(a, b)
                    if kind == "arrow":
                        v = b - a
                        ln = max(abs(v), 1e-6)
                        u = v / ln
                        n = pymupdf.Point(-u.y, u.x)
                        hl = max(6, float(o.get("width") or 1) * 5)
                        shp.draw_polyline([b - u * hl + n * hl * 0.45, b, b - u * hl - n * hl * 0.45])
                elif kind == "ellipse":
                    shp.draw_oval(r)
                elif kind == "rounded":
                    shp.draw_rect(r, radius=0.15)
                else:
                    shp.draw_rect(r)
                shp.finish(color=_rgb(o.get("stroke"), None), fill=_rgb(o.get("fill"), None), width=float(o.get("width") or 1),
                           dashes="[4 3] 0" if o.get("dashed") else None, fill_opacity=float(o.get("fill_opacity", 1)))
                shp.commit()
            elif k == "field_add":
                w = pymupdf.Widget()
                w.field_type = WIDGET_TYPES[o.get("type", "text")]
                w.rect = r
                w.field_name = o.get("name") or f"campo_{os.urandom(3).hex()}"
                w.text_fontsize = float(o.get("fontsize", 0 if o.get("type") in (None, "text") else 10))
                w.border_color = _rgb(o.get("border") or "#4d6680")
                w.border_width = 0.8
                if o.get("type") in ("combo", "list"):
                    w.choice_values = [s for s in o.get("options") or ["Opzione 1", "Opzione 2"] if str(s).strip()]
                if o.get("type") == "radio":
                    w.field_name = o.get("group") or w.field_name
                if o.get("type") == "check":
                    w.field_value = False
                page.add_widget(w)
                _set_widget(w, {key: v for key, v in o.items() if key in ("tooltip", "required", "readonly", "multiline", "editable", "value", "fill")})
                w.update()
            elif k == "field_update":
                w = _find_widget(page, o["xref"])
                if w:
                    if to:
                        w.rect = to
                    props = o.get("props") or {}
                    _set_widget(w, props)
                    w.update()
                    _sync_field(doc, w, props)
                    w = _find_widget(page, o["xref"])
                    if w:
                        w.update()
            elif k == "field_delete":
                w = _find_widget(page, o["xref"])
                if w:
                    page.delete_widget(w)
            elif k == "link_add":
                link = {"from": r}
                if o.get("uri"):
                    link.update(kind=pymupdf.LINK_URI, uri=o["uri"])
                else:
                    link.update(kind=pymupdf.LINK_GOTO, page=int(o.get("target", 1)) - 1, to=pymupdf.Point(0, 0))
                page.insert_link(link)
            elif k == "link_delete":
                for ln in page.get_links():
                    if pymupdf.Rect(ln["from"]).intersects(r):
                        page.delete_link(ln)
            elif k in ("redact", "whiteout"):
                _redact(page, r, text=True, images=True, graphics=True, fill=(0, 0, 0) if k == "redact" else (1, 1, 1))
            # ---- documento e pagine
            elif k == "metadata":
                meta = doc.metadata or {}
                meta.update({key: o.get(key, "") for key in ("title", "author", "subject", "keywords")})
                meta["producer"] = "MB Visual"
                doc.set_metadata(meta)
            elif k == "toc":
                doc.set_toc([[int(a), str(b), int(c)] for a, b, c in o.get("items", [])])
            elif k == "crop":
                page.set_cropbox(_from_pdf(page, o["box"]) * page.derotation_matrix if page.rotation else _from_pdf(page, o["box"]))
            elif k == "page_rotate":
                page.set_rotation((page.rotation + int(o.get("angle", 90))) % 360)
            elif k == "page_duplicate":
                n = int(o["page"])
                doc.fullcopy_page(n, n + 1 if n + 1 < len(doc) else -1)
            elif k == "page_delete":
                if len(doc) > 1:
                    doc.delete_page(int(o["page"]))
            elif k == "page_move":
                doc.move_page(int(o["page"]), int(o["to_page"]))
            elif k == "page_blank":
                at = int(o.get("at", len(doc)))
                ref = doc[min(max(at - 1, 0), len(doc) - 1)].rect
                doc.new_page(pno=at, width=ref.width, height=ref.height)
            elif k == "page_insert_pdf":
                with pymupdf.open(o["file"]) as other:
                    doc.insert_pdf(other, start_at=int(o.get("at", len(doc))))
            elif k == "flatten":
                doc.bake(annots=bool(o.get("annots", True)), widgets=bool(o.get("widgets", True)))
            else:
                raise ValueError(f"operazione sconosciuta: {k}")
            done += 1
        try:
            doc.subset_fonts()
        except Exception:  # noqa: BLE001
            pass
        doc.save(tmp, garbage=3, deflate=True)
    os.replace(tmp, path)
    return {"ok": True, "operazioni": done}
