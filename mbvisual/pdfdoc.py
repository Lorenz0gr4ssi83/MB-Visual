"""Editor PDF: operazioni sull'intero documento (chiamate da pdfobjects.apply_ops sulla copia di lavoro).

Pagine (ruota, elimina, duplica, riordina, inserisci da file, sostituisci, pagina bianca, ritaglia), intestazioni e pie' di
pagina, filigrana (testo o immagine, sopra o sotto il contenuto), sfondo (colore o immagine), numerazione Bates,
oscuramento da ricerca di testo e applicazione degli oscuramenti segnati, proprieta' e segnalibri, appiattimento.

Posizioni e angoli si danno come si vedono sullo schermo (pagina gia' ruotata): qui si riportano nel sistema della pagina
con derotation_matrix. Il testo usa i caratteri di Windows (pdfedit._font) incorporati con i soli caratteri usati.
"""
import base64
import datetime
import io
import os
import re

import pymupdf

from .i18n import t as tr
from .pdfedit import _font

MM = 72 / 25.4


def _rgb(c, default=(0, 0, 0)):
    from .pdfobjects import _rgb as rgb
    return rgb(c, default)


def _pages(doc, spec):
    """Pagine 0-based da un elenco [0, 2] o da una stringa "1-3, 5, 8-" (vuoto = tutte)."""
    n = len(doc)
    if spec is None or spec == "" or spec == []:
        return list(range(n))
    if isinstance(spec, (list, tuple)):
        return sorted({int(p) for p in spec if 0 <= int(p) < n})
    out = []
    for part in str(spec).replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a) if a.strip() else 1, (int(b) if b.strip() else n) + 1))
        else:
            out.append(int(part))
    pages = sorted({p - 1 for p in out if 1 <= p <= n})
    if not pages:
        raise ValueError(tr("srv_pdftools.nessuna_pagina_valida_documento_ha", n))
    return pages


def _subset(doc, pages, which):
    """Tutte / pari / dispari (numerazione da 1, come in Acrobat)."""
    if which == "even":
        return [p for p in pages if (p + 1) % 2 == 0]
    if which == "odd":
        return [p for p in pages if (p + 1) % 2 == 1]
    return pages


def _vis(page):
    """Rettangolo visibile della pagina (ruotata come si vede) e matrice verso il sistema della pagina."""
    return page.rect, page.derotation_matrix


def _put_text(page, p_vis, text, font, size, color, opacity=1.0, angle=0.0, overlay=True, anchor="left"):
    """Riga di testo con la linea di base in p_vis (coordinate visibili), ruotata di angle gradi orari sullo schermo.
    anchor: left / center / right rispetto a p_vis."""
    w = font.text_length(text, size)
    dx = {"left": 0, "center": -w / 2, "right": -w}[anchor]
    # posizione nel verso di lettura, poi nel sistema della pagina
    m_vis = pymupdf.Matrix(float(angle)) if angle else pymupdf.Identity
    start = p_vis + pymupdf.Point(dx, 0) * m_vis
    p = start * page.derotation_matrix
    tw = pymupdf.TextWriter(page.rect, color=color)  # rettangolo visibile: con quello derotato le pagine ruotate sbagliano posizione
    tw.append(p, text, font=font, fontsize=size)
    # TextWriter ruota in verso antiorario: per angle gradi orari sullo schermo su una pagina ruotata di R gradi
    rot = (page.rotation - float(angle)) % 360
    morph = (p, pymupdf.Matrix(rot)) if rot else None
    tw.write_text(page, overlay=overlay, morph=morph, opacity=opacity if opacity < 1 else -1)
    return w


# ---------------------------------------------------------------- pagine
def page_rotate(doc, o, info):
    for p in _pages(doc, o.get("pages", [o["page"]] if "page" in o else None)):
        doc[p].set_rotation((doc[p].rotation + int(o.get("angle", 90))) % 360)


def page_delete(doc, o, info):
    pages = _pages(doc, o.get("pages", [o["page"]] if "page" in o else None))
    if len(pages) >= len(doc):
        raise ValueError(tr("srv_pdftools.non_si_possono_eliminare_tutte"))
    doc.delete_pages(pages)


def page_duplicate(doc, o, info):
    pages = _pages(doc, o.get("pages", [o["page"]] if "page" in o else None))
    for p in reversed(pages):
        doc.fullcopy_page(p, p + 1 if p + 1 < len(doc) else -1)


def page_move(doc, o, info):
    doc.move_page(int(o["page"]), int(o["to_page"]))


def page_order(doc, o, info):
    order = [int(i) for i in o.get("order", [])]
    if sorted(order) != list(range(len(doc))):
        raise ValueError(tr("srv_pdfdoc.ordine_pagine_non_valido"))
    doc.select(order)


def page_blank(doc, o, info):
    at = int(o.get("at", len(doc)))
    ref = doc[min(max(at - 1, 0), len(doc) - 1)].rect
    w, h = (float(o["size"][0]), float(o["size"][1])) if o.get("size") else (ref.width, ref.height)
    for i in range(int(o.get("count", 1))):
        doc.new_page(pno=at + i, width=w, height=h)


def page_insert_pdf(doc, o, info):
    with pymupdf.open(o["file"]) as other:
        if other.needs_pass:
            raise ValueError(tr("srv_pdfdoc.file_protetto_password"))
        sel = _pages(other, o.get("from_pages") or None)
        at = int(o.get("at", len(doc)))
        for i, p in enumerate(sel):
            doc.insert_pdf(other, from_page=p, to_page=p, start_at=at + i)
    info["inserite"] = len(sel)


def page_replace(doc, o, info):
    """Sostituisce le pagine `pages` (0-based) con le pagine `from_pages` di un altro PDF (stesso numero, nell'ordine)."""
    targets = _pages(doc, o.get("pages"))
    with pymupdf.open(o["file"]) as other:
        src = _pages(other, o.get("from_pages") or None)[:len(targets)]
        for t, s in sorted(zip(targets, src), reverse=True):
            doc.insert_pdf(other, from_page=s, to_page=s, start_at=t + 1)
            doc.delete_page(t)
    info["sostituite"] = min(len(targets), len(src))


def crop(doc, o, info):
    from .pdfedit import _from_pdf
    pages = _pages(doc, o.get("pages", [o["page"]] if "page" in o else None))
    for p in pages:
        page = doc[p]
        if o.get("reset"):
            page.set_cropbox(page.mediabox)
            continue
        if o.get("margins"):  # margini in mm [alto, destra, basso, sinistra] da togliere (visti sullo schermo)
            t, rgt, b, lft = (float(v) * MM for v in o["margins"])
            vr = page.rect
            box = pymupdf.Rect(vr.x0 + lft, vr.y0 + t, vr.x1 - rgt, vr.y1 - b)
        else:
            box = _from_pdf(page, o["box"])
        box = box * page.derotation_matrix if page.rotation else box
        box = box + (page.cropbox.x0, page.cropbox.y0, page.cropbox.x0, page.cropbox.y0)
        box.normalize()
        page.set_cropbox(box & page.mediabox)


# ---------------------------------------------------------------- intestazioni, pie' di pagina, Bates
def _tokens(text, n, tot, fname, bates=""):
    today = datetime.date.today()
    return (str(text).replace("{n}", str(n)).replace("{tot}", str(tot)).replace("{data}", today.strftime("%d/%m/%Y"))
            .replace("{anno}", str(today.year)).replace("{file}", fname).replace("{bates}", bates))


def _slots(page, o, size):
    """Punti di base (coordinate visibili) delle 6 posizioni: alto/basso x sinistra/centro/destra."""
    vr = page.rect
    top, bottom, left, right = (float(v) * MM for v in (o.get("margins") or [12, 12, 15, 15]))
    y_top = vr.y0 + top + size * 0.8
    y_bot = vr.y1 - bottom
    return {"tl": (pymupdf.Point(vr.x0 + left, y_top), "left"), "tc": (pymupdf.Point(vr.width / 2, y_top), "center"),
            "tr": (pymupdf.Point(vr.x1 - right, y_top), "right"), "bl": (pymupdf.Point(vr.x0 + left, y_bot), "left"),
            "bc": (pymupdf.Point(vr.width / 2, y_bot), "center"), "br": (pymupdf.Point(vr.x1 - right, y_bot), "right")}


def header_footer(doc, o, info):
    items = {k: v for k, v in (o.get("items") or {}).items() if v}
    if not items:
        return
    size = float(o.get("size") or 9)
    font = _font(o.get("font") or "Helvetica", bool(o.get("bold")), False)
    color = _rgb(o.get("color") or "#333333")
    pages = _subset(doc, _pages(doc, o.get("pages")), o.get("which"))
    start = int(o.get("start") or 1)
    tot = len(doc) + start - 1
    fname = os.path.splitext(o.get("filename") or "")[0]
    for p in pages:
        page = doc[p]
        slots = _slots(page, o, size)
        for key, text in items.items():
            if key not in slots:
                continue
            pt, anchor = slots[key]
            for i, line in enumerate(_tokens(text, p + start, tot, fname).split("\n")):
                _put_text(page, pt + (0, i * size * 1.2), line, font, size, color, anchor=anchor)
    info["pagine"] = len(pages)


def bates(doc, o, info):
    size = float(o.get("size") or 9)
    font = _font(o.get("font") or "Helvetica", bool(o.get("bold", True)), False)
    color = _rgb(o.get("color") or "#000000")
    pages = _pages(doc, o.get("pages"))
    num = int(o.get("start") or 1)
    digits = int(o.get("digits") or 6)
    pos = o.get("pos") or "br"
    first = last = ""
    for p in pages:
        code = f"{o.get('prefix', '')}{num:0{digits}d}{o.get('suffix', '')}"
        pt, anchor = _slots(doc[p], o, size)[pos]
        _put_text(doc[p], pt, code, font, size, color, anchor=anchor)
        first = first or code
        last = code
        num += 1
    info["bates"] = [first, last]


# ---------------------------------------------------------------- filigrana e sfondo
def _image_rgba(data, opacity=1.0, angle=0.0):
    from PIL import Image
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    if opacity < 1:
        im.putalpha(im.getchannel("A").point(lambda v, k=max(0.0, opacity): int(v * k)))
    if angle % 360:
        im = im.rotate(-angle, expand=True, resample=Image.BICUBIC)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue(), im.size


def _place(vr, w, h, pos, margin=36):
    """Riquadro w x h nella pagina visibile secondo la posizione (center, tl, tc, tr, ml, mr, bl, bc, br)."""
    x = {"l": vr.x0 + margin, "c": vr.x0 + (vr.width - w) / 2, "r": vr.x1 - margin - w}
    y = {"t": vr.y0 + margin, "m": vr.y0 + (vr.height - h) / 2, "b": vr.y1 - margin - h}
    pos = pos or "center"
    if pos == "center":
        pos = "mc"
    vy, hx = pos[0], pos[1]
    return pymupdf.Rect(x[hx], y[vy], x[hx] + w, y[vy] + h)


def watermark(doc, o, info):
    pages = _pages(doc, o.get("pages"))
    opacity = float(o.get("opacity", 0.3))
    angle = float(o.get("angle", 45 if o.get("text") else 0))
    behind = bool(o.get("behind"))
    scale = float(o.get("scale") or 50) / 100
    pos = o.get("pos") or "center"
    if o.get("image"):
        raw = base64.b64decode(o["image"])
        data, (iw, ih) = _image_rgba(raw, opacity, -angle)
        for p in pages:
            page = doc[p]
            vr = page.rect
            k = min(vr.width * scale / iw, vr.height * scale / ih)
            box = _place(vr, iw * k, ih * k, pos)
            page.insert_image(box * page.derotation_matrix, stream=data, overlay=not behind, rotate=page.rotation)
    else:
        text = o.get("text") or ""
        font = _font(o.get("font") or "Helvetica", bool(o.get("bold", True)), False)
        color = _rgb(o.get("color") or "#c62828")
        lines = text.split("\n")
        for p in pages:
            page = doc[p]
            vr = page.rect
            if o.get("size"):
                size = float(o["size"])
            else:  # dimensione relativa: la riga piu' lunga occupa "scale" della diagonale (o della larghezza se dritta)
                span = (vr.width ** 2 + vr.height ** 2) ** 0.5 if angle % 180 else vr.width
                size = span * scale / max(1, max(font.text_length(ln, 1) for ln in lines))
            lh = size * 1.15
            box = _place(vr, 1, lh * len(lines), pos)
            c = pymupdf.Point((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)
            m = pymupdf.Matrix(-angle)
            for i, ln in enumerate(lines):
                off = pymupdf.Point(0, (i - (len(lines) - 1) / 2) * lh + size * 0.35) * m
                _put_text(page, c + off, ln, font, size, color, opacity, -angle, overlay=not behind, anchor="center")
    info["pagine"] = len(pages)


def background(doc, o, info):
    pages = _pages(doc, o.get("pages"))
    opacity = float(o.get("opacity", 1))
    for p in pages:
        page = doc[p]
        full = page.rect * page.derotation_matrix if page.rotation else page.rect
        if o.get("image"):
            data, _ = _image_rgba(base64.b64decode(o["image"]), opacity)
            page.insert_image(full, stream=data, overlay=False, keep_proportion=False, rotate=page.rotation)
        else:
            sh = page.new_shape()
            sh.draw_rect(full)
            sh.finish(color=None, fill=_rgb(o.get("color") or "#fff8e1"), fill_opacity=opacity)
            sh.commit(overlay=False)
    info["pagine"] = len(pages)


# ---------------------------------------------------------------- oscuramento
def redact_search(doc, o, info):
    """Segna come oscuramenti (annotazioni Redact) tutte le occorrenze dei testi cercati; con `regex` anche schemi
    (codici fiscali, email, IBAN...). Restituisce il numero di occorrenze."""
    terms = [t for t in (o.get("terms") or []) if str(t).strip()]
    case = bool(o.get("case"))
    count = 0
    for p in _pages(doc, o.get("pages")):
        page = doc[p]
        rects = []
        if o.get("regex"):
            words = page.get_text("words")
            for pat in terms:
                rx = re.compile(pat, 0 if case else re.I)
                rects += [pymupdf.Rect(w[:4]) for w in words if rx.fullmatch(w[4])]
        else:
            for term in terms:
                hits = page.search_for(term)
                if case:
                    hits = [h for h in hits if term in page.get_textbox(h + (-0.5, -0.5, 0.5, 0.5))]
                rects += hits
        for r in rects:
            a = page.add_redact_annot(r, fill=_rgb(o.get("fill") or "#000000"))
            a.set_info(title=o.get("author") or "MB Desk")
            a.update()
        count += len(rects)
    info["trovati"] = info.get("trovati", 0) + count


def redact_apply(doc, o, info):
    n = 0
    for page in doc:
        if any(a.type[0] == pymupdf.PDF_ANNOT_REDACT for a in page.annots()):
            n += sum(1 for a in page.annots() if a.type[0] == pymupdf.PDF_ANNOT_REDACT)
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS if o.get("images", True) else pymupdf.PDF_REDACT_IMAGE_NONE,
                                  graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED if o.get("graphics", True) else pymupdf.PDF_REDACT_LINE_ART_NONE,
                                  text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    if o.get("metadata"):  # oscuramento completo: anche proprieta' e dati nascosti
        doc.set_metadata({})
        doc.del_xml_metadata()
    info["applicati"] = n


# ---------------------------------------------------------------- documento
def metadata(doc, o, info):
    meta = doc.metadata or {}
    meta.update({key: o.get(key, "") for key in ("title", "author", "subject", "keywords") if key in o})
    meta["producer"] = "MB Desk"
    doc.set_metadata(meta)


def toc(doc, o, info):
    doc.set_toc([[int(a), str(b), int(c)] for a, b, c in o.get("items", [])])


def flatten(doc, o, info):
    doc.bake(annots=bool(o.get("annots", True)), widgets=bool(o.get("widgets", True)))


def sanitize(doc, o, info):
    """Rimuove informazioni nascoste: metadati, allegati, JavaScript, collegamenti esterni, commenti (a scelta)."""
    doc.scrub(metadata=bool(o.get("metadata", True)), xml_metadata=bool(o.get("metadata", True)), attached_files=bool(o.get("attachments", True)),
              embedded_files=bool(o.get("attachments", True)), javascript=bool(o.get("javascript", True)), reset_responses=False,
              hidden_text=bool(o.get("hidden_text", True)), redactions=True, remove_links=bool(o.get("links", False)),
              reset_fields=False, thumbnails=True)


OPS = {
    "page_rotate": page_rotate, "page_delete": page_delete, "page_duplicate": page_duplicate, "page_move": page_move,
    "page_order": page_order, "page_blank": page_blank, "page_insert_pdf": page_insert_pdf, "page_replace": page_replace,
    "crop": crop, "header_footer": header_footer, "bates": bates, "watermark": watermark, "background": background,
    "redact_search": redact_search, "redact_apply": redact_apply, "metadata": metadata, "toc": toc, "flatten": flatten,
    "sanitize": sanitize,
}
