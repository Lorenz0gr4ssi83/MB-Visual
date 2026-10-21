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
from .i18n import t as tr

WIDGET_TYPES = {
    "text": pymupdf.PDF_WIDGET_TYPE_TEXT, "combo": pymupdf.PDF_WIDGET_TYPE_COMBOBOX, "list": pymupdf.PDF_WIDGET_TYPE_LISTBOX,
    "check": pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "radio": pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON, "signature": pymupdf.PDF_WIDGET_TYPE_SIGNATURE,
}
TYPE_NAMES = {v: k for k, v in WIDGET_TYPES.items()}
MAX_PATHS = 25000  # oltre (disegni CAD molto densi) i tracciati non si elencano uno per uno


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
            if pymupdf.Rect(info["bbox"]).is_empty:
                continue
            # tutte le immagini sono modificabili: quelle senza xref (in linea) si ricavano dalla pagina
            out.append({"kind": "image", "xref": info.get("xref", 0), "box": _to_pdf(page, info["bbox"]),
                        "px": [info.get("width"), info.get("height")], "movable": True})
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
        # disegni vettoriali: gruppi (tracciati vicini, come li vede l'occhio) + singoli tracciati per entrare nel gruppo
        draws = _page_draws(page)
        paths = []
        for d in draws[:MAX_PATHS]:
            r = pymupdf.Rect(d["rect"])
            if r.width == 0 and r.height == 0:
                continue
            paths.append({"kind": "drawing", "seqno": d.get("seqno"), "box": _to_pdf(page, r), "stroke": _hex(d.get("color")),
                          "fill": _hex(d.get("fill")), "width": round(d.get("width") or 0, 2),
                          "opacity": d.get("fill_opacity") if d.get("fill") else d.get("stroke_opacity"), "dashed": bool(d.get("dashes") and d["dashes"] not in ("[] 0", "[] 0.0"))})
        if 0 < len(draws) <= MAX_PATHS:
            try:
                clusters = page.cluster_drawings(drawings=draws, x_tolerance=3, y_tolerance=3)
            except Exception:  # noqa: BLE001
                clusters = []
            for c in clusters:
                big = c + (-0.6, -0.6, 0.6, 0.6)
                members = [d for d in draws if pymupdf.Rect(d["rect"]) in big]
                if not members:
                    continue
                strokes = [_hex(d.get("color")) for d in members if d.get("color")]
                fills = [_hex(d.get("fill")) for d in members if d.get("fill")]
                out.append({"kind": "group", "box": _to_pdf(page, c), "n": len(members),
                            "stroke": max(set(strokes), key=strokes.count) if strokes else None,
                            "fill": max(set(fills), key=fills.count) if fills else None,
                            "width": round(max((d.get("width") or 0) for d in members), 2)})
        # annotazioni (evidenziazioni, note, timbri, disegni a mano, caselle di testo...)
        for a in page.annots():
            try:
                cols = a.colors or {}
                out.append({"kind": "annot", "xref": a.xref, "type": a.type[1], "box": _to_pdf(page, a.rect),
                            "stroke": _hex(cols.get("stroke")), "fill": _hex(cols.get("fill")), "opacity": a.opacity if a.opacity >= 0 else 1,
                            "width": (a.border or {}).get("width") or 0, "contents": (a.info or {}).get("content", "")})
            except Exception:  # noqa: BLE001
                pass
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
        return {"ok": True, "oggetti": out, "tracciati": paths, "troppi_disegni": len(draws) > MAX_PATHS, "pagine": len(doc), "metadata": {k: meta.get(k, "") for k in ("title", "author", "subject", "keywords")},
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


def _same_box(a, b, tol=1.5):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def _image_count(doc, xref) -> int:
    """Quante volte un'immagine compare nel documento (logo ripetuto su ogni pagina, ecc.)."""
    n = 0
    for p in doc:
        n += sum(1 for i in p.get_image_info(xrefs=True) if i.get("xref") == xref)
    return n


def _take_image(doc, page, xref, r):
    """Restituisce (PNG/JPEG, riquadro) dell'immagine nel riquadro r e la toglie SOLO da questo punto della pagina.
    Non si usa delete_image: cambierebbe l'immagine condivisa ovunque (es. lo stesso logo sulle altre pagine)."""
    if xref:
        try:
            data = _image_bytes(doc, xref)
        except Exception:  # noqa: BLE001
            data = None
    else:
        data = None
    if data is None:  # immagine in linea o non estraibile: si ricava dalla pagina alla sua risoluzione
        info = next((i for i in page.get_image_info() if _same_box(i["bbox"], r)), None)
        dpi = 150
        if info and r.width:
            dpi = max(72, min(600, int(72 * (info.get("width") or 1) / r.width)))
        data = page.get_pixmap(clip=r, dpi=dpi).tobytes("png")
    others = [i for i in page.get_image_info(xrefs=True) if not _same_box(i["bbox"], r) and pymupdf.Rect(i["bbox"]).intersects(r)]
    page.add_redact_annot(r + (-0.3, -0.3, 0.3, 0.3))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS if others else pymupdf.PDF_REDACT_IMAGE_REMOVE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_NONE)
    return data


def _process_image(data: bytes, o: dict) -> bytes:
    """Colori trasparenti (anche piu' di uno, con tolleranza), opacita', rotazione, specchio, bianco e nero."""
    import io

    from PIL import Image, ImageChops, ImageOps
    im = Image.open(io.BytesIO(data))
    im.load()
    im = im.convert("RGBA")
    if o.get("gray"):
        a = im.getchannel("A")
        im = ImageOps.grayscale(im).convert("RGBA")
        im.putalpha(a)
    cols = [c for c in (o.get("transparent") or []) if c]
    if cols:
        tol = max(0, min(100, float(o.get("tol", 12)))) * 2.55
        rgb = im.convert("RGB")
        alpha = im.getchannel("A")
        for c in cols:
            r, g, b = (int(round(v * 255)) for v in _rgb(c))
            diff = ImageChops.difference(rgb, Image.new("RGB", im.size, (r, g, b)))
            dr, dg, db = diff.split()
            dmax = ImageChops.lighter(ImageChops.lighter(dr, dg), db)
            keep = dmax.point(lambda v, t=tol: 255 if v > t else 0)  # 0 dove il colore e' "uguale" (entro la tolleranza)
            alpha = ImageChops.multiply(alpha, keep)
        im.putalpha(alpha)
    op = o.get("opacity")
    if op is not None and float(op) < 1:
        im.putalpha(im.getchannel("A").point(lambda v, k=max(0.0, float(op)): int(v * k)))
    if o.get("flip_h"):
        im = ImageOps.mirror(im)
    if o.get("flip_v"):
        im = ImageOps.flip(im)
    rot = int(o.get("rotate") or 0) % 360
    if rot:
        im = im.rotate(-rot, expand=True)  # gradi in senso orario
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _draw_paths(page, paths, dx=0.0, dy=0.0, sx=1.0, sy=1.0, ox=0.0, oy=0.0, style=None, targets=None, overlay=True):
    """Ridisegna percorsi vettoriali (da get_drawings) traslati/scalati attorno a (ox, oy).
    style: nuovo aspetto (stroke, fill, width, opacity, dashed) per i tracciati in targets (None = tutti)."""
    T = lambda p: pymupdf.Point(ox + (p.x - ox) * sx + dx, oy + (p.y - oy) * sy + dy)  # noqa: E731
    shape = page.new_shape()
    for path in paths:
        if style and (targets is None or path.get("seqno") in targets):
            path = dict(path)
            if "stroke" in style:
                path["color"] = _rgb(style["stroke"], None)
            if "fill" in style:
                path["fill"] = _rgb(style["fill"], None)
            if style.get("width") is not None:
                path["width"] = float(style["width"])
            if style.get("opacity") is not None:
                path["fill_opacity"] = path["stroke_opacity"] = float(style["opacity"])
            if "dashed" in style:
                path["dashes"] = f"[{3 * max(1, path.get('width') or 1):.2f} {2 * max(1, path.get('width') or 1):.2f}] 0" if style["dashed"] else None
            if path.get("color") is None and path.get("fill") is None:
                continue  # ne' bordo ne' riempimento: tracciato invisibile
        if path.get("color") is None and path.get("fill") is None:
            continue
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
    shape.commit(overlay=overlay)


def _page_draws(page):
    """Tracciati del contenuto della pagina. get_drawings riporta anche l'aspetto di campi modulo e annotazioni
    (bordi, sottolineature): non sono disegni della pagina e non si toccano con le operazioni sui disegni."""
    boxes = [pymupdf.Rect(a.rect) + (-1, -1, 1, 1) for a in page.annots()] + [pymupdf.Rect(w.rect) + (-1, -1, 1, 1) for w in page.widgets()]
    out = page.get_drawings()
    if boxes:
        out = [d for d in out if not any(pymupdf.Rect(d["rect"]) in b for b in boxes)]
    return out


def _paths_in(page, rect, tol=0.6):
    big = rect + (-tol, -tol, tol, tol)
    return [p for p in _page_draws(page) if pymupdf.Rect(p["rect"]) in big]


def _find_widget(page, xref):
    for w in page.widgets():
        if w.xref == int(xref):
            return w
    return None


def _find_annot(page, xref):
    for a in page.annots():
        if a.xref == int(xref):
            return a
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
    """Applica le operazioni e sostituisce il file. Le operazioni girano in una funzione a parte: campi, pagine e
    annotazioni di PyMuPDF ancora in memoria tengono aperto il file anche a documento chiuso e Windows ne rifiuta
    la sostituzione; finita la funzione si liberano (gc) e la sostituzione si ritenta per qualche istante."""
    import gc
    import time
    tmp = path + ".mbv-ops.pdf"
    try:
        done = _apply_ops(path, tmp, ops)
        for attempt in range(25):
            gc.collect()
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 24:
                    raise
                time.sleep(0.2)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return {"ok": True, "operazioni": done}


def _apply_ops(path: str, tmp: str, ops: list[dict]) -> int:
    done = 0
    with pymupdf.open(path) as doc:
        for o in ops:
            k = o["kind"]
            page = doc[int(o["page"])] if "page" in o and o["page"] is not None and k not in ("page_delete", "page_move") else None
            r = _from_pdf(page, o["box"]) if page is not None and o.get("box") else None
            if r is None and page is not None and k.startswith("image_") and o.get("xref"):
                # richiesta senza riquadro: si usa la posizione dell'immagine sulla pagina
                hit = next((i for i in page.get_image_info(xrefs=True) if i.get("xref") == int(o["xref"])), None)
                r = pymupdf.Rect(hit["bbox"]) if hit else None
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
                data = _take_image(doc, page, int(o.get("xref") or 0), r)
                page.insert_image(to, stream=data, keep_proportion=False)
            elif k == "image_replace":
                data = base64.b64decode(o["data"])
                _take_image(doc, page, int(o.get("xref") or 0), r)
                page.insert_image(r, stream=data, keep_proportion=bool(o.get("keep", True)))
            elif k == "image_delete":
                _take_image(doc, page, int(o.get("xref") or 0), r)
            elif k == "image_edit":
                # trasparenze, opacita', rotazione, specchio, bianco e nero
                xref = int(o.get("xref") or 0)
                rot = int(o.get("rotate") or 0) % 360
                if xref and not to and rot in (0, 180) and _image_count(doc, xref) == 1:
                    # stessa posizione e immagine usata una volta sola: si sostituisce sul posto (resta sotto/sopra come prima)
                    page.replace_image(xref, stream=_process_image(_image_bytes(doc, xref), o))
                else:
                    data = _process_image(_take_image(doc, page, xref, r), o)
                    dest = to or r
                    if rot in (90, 270):  # riquadro ruotato attorno al centro
                        c = (dest.tl + dest.br) / 2
                        dest = pymupdf.Rect(c.x - dest.height / 2, c.y - dest.width / 2, c.x + dest.height / 2, c.y + dest.width / 2)
                    page.insert_image(dest, stream=data, keep_proportion=False)
            elif k in ("draw_move", "draw_delete", "draw_edit"):
                # gruppo o singolo tracciato: si tolgono i tracciati contenuti nel riquadro e si ridisegnano
                # (spostati / con il nuovo aspetto); quelli non scelti tornano identici
                # la zona include mezzo spessore del bordo: altrimenti i tratti spessi restano (copiati invece che spostati)
                first = _paths_in(page, r)
                m = max([(p.get("width") or 0) for p in first] + [0]) / 2 + 1
                zone = r + (-m, -m, m, m)
                # MuPDF non toglie i tracciati racchiusi in un altro ("coperti"): si tolgono quelli che toccano la zona
                # e si ridisegnano identici quelli che non fanno parte del gruppo
                touched = [p for p in _page_draws(page) if (pymupdf.Rect(p["rect"]) + (-0.05, -0.05, 0.05, 0.05)).intersects(zone)]
                strangers = [p for p in touched if pymupdf.Rect(p["rect"]) not in zone]
                paths = [p for p in touched if pymupdf.Rect(p["rect"]) in zone]
                targets = set(o["targets"]) if o.get("targets") else None
                page.add_redact_annot(zone)
                page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                                      text=pymupdf.PDF_REDACT_TEXT_NONE)
                if strangers:
                    _draw_paths(page, strangers, overlay=False)
                if k == "draw_delete" or o.get("delete"):
                    paths = [p for p in paths if targets is not None and p.get("seqno") not in targets]
                    to = None
                if paths:
                    dest = to or r
                    sx = dest.width / r.width if r.width else 1
                    sy = dest.height / r.height if r.height else 1
                    # sotto testi e immagini (sfondi, tabelle), salvo che il gruppo stia sopra un'immagine
                    over = any(pymupdf.Rect(i["bbox"]).intersects(dest) for i in page.get_image_info())
                    if targets is not None and to is not None:  # spostamento di singoli tracciati: gli altri restano fermi
                        _draw_paths(page, [p for p in paths if p.get("seqno") not in targets], overlay=over)
                        _draw_paths(page, [p for p in paths if p.get("seqno") in targets], dest.x0 - r.x0, dest.y0 - r.y0, sx, sy, r.x0, r.y0,
                                    style=o.get("style"), overlay=over)
                    else:
                        _draw_paths(page, paths, dest.x0 - r.x0, dest.y0 - r.y0, sx, sy, r.x0, r.y0, style=o.get("style"), targets=targets, overlay=over)
            # ---- annotazioni esistenti e nuove
            elif k == "annot_update":
                a = _find_annot(page, o["xref"])
                if a:
                    p = o.get("props") or {}
                    if "stroke" in p or "fill" in p:
                        cur = a.colors or {}
                        a.set_colors(stroke=_rgb(p["stroke"], None) if "stroke" in p else cur.get("stroke"),
                                     fill=_rgb(p["fill"], None) if "fill" in p else cur.get("fill"))
                    if p.get("opacity") is not None:
                        a.set_opacity(float(p["opacity"]))
                    if p.get("width") is not None:
                        try:
                            a.set_border(width=float(p["width"]))
                        except Exception:  # noqa: BLE001
                            pass
                    if "contents" in p:
                        a.set_info(content=p["contents"])
                    if to:
                        try:
                            a.set_rect(to)
                        except Exception:  # noqa: BLE001
                            pass
                    a.update()
            elif k == "annot_delete":
                a = _find_annot(page, o["xref"])
                if a:
                    page.delete_annot(a)
            elif k == "annot_add":
                # sottolineato, barrato, ondulato, evidenziato sulle parole del riquadro; nota adesiva nel punto
                t = o.get("type", "underline")
                col = _rgb(o.get("color") or {"underline": "#1565c0", "strikeout": "#d32f2f", "squiggly": "#d32f2f", "highlight": "#ffeb3b"}.get(t, "#ffcc00"))
                if t == "note":
                    a = page.add_text_annot(r.tl, o.get("text", ""), icon="Note")
                else:
                    words = page.get_text("words", clip=r)
                    if not words:
                        raise ValueError(tr("srv_pdfobjects.nessun_testo_riquadro_trascina_sopra"))
                    quads = [pymupdf.Rect(w[:4]).quad for w in words]
                    a = {"underline": page.add_underline_annot, "strikeout": page.add_strikeout_annot,
                         "squiggly": page.add_squiggly_annot, "highlight": page.add_highlight_annot}[t](quads)
                a.set_colors(stroke=col)
                if o.get("opacity") is not None:
                    a.set_opacity(float(o["opacity"]))
                a.set_info(title=o.get("author") or "MB Visual")
                a.update()
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
                    w.choice_values = [s for s in o.get("options") or [tr("srv_pdfobjects.opzione_1"), tr("srv_pdfobjects.opzione_2")] if str(s).strip()]
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
                raise ValueError(tr("srv_pdfobjects.operazione_sconosciuta_0", k))
            done += 1
        try:
            doc.subset_fonts()
        except Exception:  # noqa: BLE001
            pass
        doc.save(tmp, garbage=3, deflate=True)
    return done
