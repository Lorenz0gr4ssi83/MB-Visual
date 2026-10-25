"""Editor PDF avanzato (PyMuPDF): oggetti della pagina e operazioni di modifica.

Oggetti: immagini, blocchi di testo, disegni vettoriali (gruppi e singoli tracciati), annotazioni, campi modulo, collegamenti.
Operazioni (applicate in ordine alla copia di lavoro): testo a blocchi (con il carattere incorporato nel PDF quando contiene
tutti i caratteri), macchina da scrivere, immagini (inserisci, sposta, ridimensiona, ruota, ritaglia, sostituisci, regolazioni,
trasparenze, elimina), disegni (sposta, ruota, aspetto, elimina), ordine di sovrapposizione, copia tra pagine, forme,
annotazioni e commenti (risposte, stato), campi modulo, collegamenti, oscuramento in due fasi (segna / applica, anche da una
ricerca di testo), bianchetto. Le operazioni sul documento (pagine, intestazioni, filigrana, sfondo, Bates) sono in pdfdoc.py.
Coordinate scambiate con l'interfaccia: spazio PDF (origine in basso a sinistra), come pdf.js. Gli angoli sono in gradi in
senso orario come si vedono sullo schermo.
"""
import base64
import os
import re

import pymupdf

from .pdfedit import _font, _from_pdf, _to_pdf, fix_tounicode
from .i18n import t as tr

WIDGET_TYPES = {
    "text": pymupdf.PDF_WIDGET_TYPE_TEXT, "combo": pymupdf.PDF_WIDGET_TYPE_COMBOBOX, "list": pymupdf.PDF_WIDGET_TYPE_LISTBOX,
    "check": pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "radio": pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON, "signature": pymupdf.PDF_WIDGET_TYPE_SIGNATURE,
}
TYPE_NAMES = {v: k for k, v in WIDGET_TYPES.items()}
MAX_PATHS = 25000  # oltre (disegni CAD molto densi) i tracciati non si elencano uno per uno
# stati di revisione dei commenti (modello "Review" di Acrobat): risposte nascoste con /State
STATES = ("None", "Accepted", "Rejected", "Cancelled", "Completed")


def _rgb(c, default=(0, 0, 0)):
    """'#rrggbb' -> RGB 0-1; 'cmyk(c,m,y,k)' (percentuali) -> CMYK 0-1 (il PDF lo scrive come colore di stampa)."""
    if c in (None, "", "none"):
        return None if default is None else default
    s = str(c).strip()
    m = re.match(r"cmyk\(([^)]*)\)", s, re.I)
    if m:
        v = [max(0.0, min(100.0, float(x))) / 100 for x in m.group(1).split(",")[:4]]
        return tuple((v + [0, 0, 0, 0])[:4])
    s = s.lstrip("#").ljust(6, "0")
    return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _hex(c):
    if c is None:
        return None
    if isinstance(c, (list, tuple)):
        if len(c) == 1:
            c = (c[0], c[0], c[0])
        elif len(c) == 4:  # CMYK -> RGB (per mostrarlo)
            k = 1 - c[3]
            c = ((1 - c[0]) * k, (1 - c[1]) * k, (1 - c[2]) * k)
        if len(c) >= 3:
            return "#%02x%02x%02x" % tuple(max(0, min(255, round(v * 255))) for v in c[:3])
    if isinstance(c, int):
        return f"#{c:06x}"
    return None


def _dash_kind(d):
    """Tratteggio di un tracciato: '', 'dash', 'dot', 'dashdot' (dalla stringa di get_drawings)."""
    if not d or d in ("[] 0", "[] 0.0", "[]0"):
        return ""
    nums = [float(x) for x in re.findall(r"[\d.]+", d.split("]")[0])]
    if not nums:
        return ""
    if len(nums) >= 4:
        return "dashdot"
    return "dot" if nums[0] <= 1.01 else "dash"


def _dashes(kind, width):
    w = max(1.0, float(width or 1))
    return {"dash": f"[{3 * w:.2f} {2 * w:.2f}] 0", "dot": f"[{0.01:.2f} {2 * w:.2f}] 0",
            "dashdot": f"[{4 * w:.2f} {1.5 * w:.2f} {0.01:.2f} {1.5 * w:.2f}] 0"}.get(kind or "", None)


# ---------------------------------------------------------------- lettura degli oggetti di una pagina
def _paragraphs(rows, bbox, area, page_w, vertical):
    """Testo del blocco con le righe "a capo automatico" unite in paragrafi (si ridistribuiscono quando si riscrive) e
    allineamento: 0 sinistra, 1 centro, 2 destra, 3 giustificato. area = (x0, x1) del testo della pagina."""
    x0, x1 = bbox[0], bbox[2]
    w = max(x1 - x0, 1)
    if vertical or len(rows) == 1:
        align = 0
        if not vertical and len(rows) == 1:
            r0, r1 = rows[0][1], rows[0][2]  # limiti della riga vera (il blocco puo' comprendere righe vuote)
            if abs((r0 + r1) / 2 - (area[0] + area[1]) / 2) < page_w * 0.02 and r1 - r0 < (area[1] - area[0]) * 0.9:
                align = 1  # titolo centrato nell'area del testo
            elif abs(r1 - area[1]) < 2 and r0 - area[0] > (area[1] - area[0]) * 0.3:
                align = 2  # riga allineata al margine destro (date, firme)
        return "\n".join(r[0] for r in rows), align
    lefts = [r[1] - x0 for r in rows]
    rights = [x1 - r[2] for r in rows]
    centers = [abs((r[1] + r[2]) / 2 - (x0 + x1) / 2) for r in rows]
    tol = max(2.0, w * 0.01)
    full = [r[2] - r[1] > w * 0.85 for r in rows]
    if all(c < tol for c in centers) and not all(full):
        align = 1
    elif all(rt < tol for rt in rights) and not all(lt < tol for lt in lefts):
        align = 2
    elif sum(1 for f, rt in zip(full[:-1], rights[:-1]) if f and rt < tol) >= max(1, (len(rows) - 1) * 0.8) and all(lt < tol for lt in lefts):
        align = 3
    else:
        align = 0
    out = rows[0][0]
    for prev, cur, f in zip(rows, rows[1:], full):
        soft = f and not prev[0].rstrip().endswith((".", ":", ";", "!", "?"))  # riga piena: a capo automatico
        out += (" " if soft else "\n") + cur[0].lstrip()
    return out, align


def page_objects(path: str, pno: int) -> dict:
    with pymupdf.open(path) as doc:
        page = doc[pno]
        out, colors = [], {}
        # immagini usate su piu' pagine (logo ripetuto): conteggio dalle risorse, senza decodificarle
        uses: dict = {}
        for pp in range(len(doc)):
            if pp != pno:
                for im in doc.get_page_images(pp):
                    uses[im[0]] = uses.get(im[0], 0) + 1
        infos = page.get_image_info(xrefs=True)
        for i in infos:
            if i.get("xref"):
                uses[i["xref"]] = uses.get(i["xref"], 0) + 1

        def seen(c, n=1):
            if c:
                colors[c] = colors.get(c, 0) + n

        for info in infos:
            if (info.get("width") or 0) <= 1 and (info.get("height") or 0) <= 1:
                continue  # immagine eliminata (segnaposto trasparente lasciato da PyMuPDF)
            if pymupdf.Rect(info["bbox"]).is_empty:
                continue
            # tutte le immagini sono modificabili: quelle senza xref (in linea) si ricavano dalla pagina
            out.append({"kind": "image", "xref": info.get("xref", 0), "box": _to_pdf(page, info["bbox"]),
                        "px": [info.get("width"), info.get("height")], "bpc": info.get("bpc"), "cs": info.get("cs-name", ""),
                        "shared": uses.get(info.get("xref"), 0) > 1})
        blocks = page.get_text("dict")["blocks"]
        # area occupata dal testo (margini del documento): i titoli si centrano su questa, non sul foglio
        xs = [(ln["bbox"][0], ln["bbox"][2]) for b in blocks if b.get("type") == 0 for ln in b["lines"]
              if "".join(sp["text"] for sp in ln["spans"]).strip() and abs(ln["dir"][1]) < 0.5]
        area = (min(x[0] for x in xs), max(x[1] for x in xs)) if xs else (page.rect.x0, page.rect.x1)
        for b in blocks:
            if b.get("type") != 0:
                continue
            rows, first, bases = [], None, []  # rows: (testo, x0, x1) delle righe non vuote
            for ln in b["lines"]:
                t = "".join(s["text"] for s in ln["spans"]).rstrip()
                if t.strip():
                    rows.append((t, ln["bbox"][0], ln["bbox"][2]))
                    sp = next((s for s in ln["spans"] if s["text"].strip()), None)
                    first = first or sp
                    if sp:
                        bases.append(sp["origin"][1])
                for s in ln["spans"]:
                    if s["text"].strip():
                        seen(_hex(s["color"]), len(s["text"]))
            if not rows or not first:
                continue
            gaps = [b2 - b1 for b1, b2 in zip(bases, bases[1:]) if b2 > b1]
            lh = round(sorted(gaps)[len(gaps) // 2] / first["size"], 2) if gaps and first["size"] else 1.15
            d0 = next((ln["dir"] for ln in b["lines"] if "".join(sp["text"] for sp in ln["spans"]).strip()), (1, 0))
            # porzioni sulla stessa linea di base (pallino dell'elenco + testo, tabulazioni): una sola riga
            merged, mb = [], []
            for r, y in zip(rows, bases):
                if merged and abs(y - mb[-1]) < 1 and r[1] >= merged[-1][2] - 1:
                    merged[-1] = (merged[-1][0] + ("\t" if r[1] - merged[-1][2] > first["size"] * 0.6 else " ") + r[0].lstrip(), merged[-1][1], r[2])
                else:
                    merged.append(r)
                    mb.append(y)
            text, align = _paragraphs(merged, b["bbox"], area, page.rect.width, abs(d0[1]) > 0.5)
            out.append({"kind": "text", "box": _to_pdf(page, b["bbox"]), "text": text, "font": first["font"], "dir": [round(d0[0], 4), round(d0[1], 4)],
                        "size": round(first["size"], 2), "color": _hex(first["color"]), "lineheight": lh, "align": align, "lines": len(merged),
                        "bold": bool(first["flags"] & 16) or "bold" in first["font"].lower(),
                        "italic": bool(first["flags"] & 2) or "italic" in first["font"].lower(),
                        "embedded": _embedded_font(doc, page, first["font"], text) is not None})
        # disegni vettoriali: gruppi (tracciati vicini, come li vede l'occhio) + singoli tracciati per entrare nel gruppo
        draws = _cached_draws(path, pno, page)
        paths = []
        for d in draws[:MAX_PATHS]:
            r = pymupdf.Rect(d["rect"])
            seen(_hex(d.get("color")))
            seen(_hex(d.get("fill")))
            if r.width == 0 and r.height == 0:
                continue
            paths.append({"kind": "drawing", "seqno": d.get("seqno"), "box": _to_pdf(page, r), "stroke": _hex(d.get("color")),
                          "fill": _hex(d.get("fill")), "width": round(d.get("width") or 0, 2),
                          "opacity": d.get("fill_opacity") if d.get("fill") else d.get("stroke_opacity"),
                          "dash": _dash_kind(d.get("dashes")), "dashed": bool(_dash_kind(d.get("dashes")))})
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
                dashes = [_dash_kind(d.get("dashes")) for d in members]
                out.append({"kind": "group", "box": _to_pdf(page, c), "n": len(members),
                            "stroke": max(set(strokes), key=strokes.count) if strokes else None,
                            "fill": max(set(fills), key=fills.count) if fills else None,
                            "width": round(max((d.get("width") or 0) for d in members), 2),
                            "dash": max(set(dashes), key=dashes.count) if dashes else ""})
        # annotazioni (evidenziazioni, note, timbri, disegni a mano, caselle di testo, oscuramenti segnati...)
        for a in page.annots():
            try:
                if a.irt_xref:  # risposte e stati: si vedono nell'elenco dei commenti, non sulla pagina
                    continue
                cols = a.colors or {}
                info = a.info or {}
                out.append({"kind": "annot", "xref": a.xref, "type": a.type[1], "box": _to_pdf(page, a.rect),
                            "stroke": _hex(cols.get("stroke")), "fill": _hex(cols.get("fill")), "opacity": a.opacity if a.opacity >= 0 else 1,
                            "width": (a.border or {}).get("width") or 0, "contents": info.get("content", ""), "author": info.get("title", ""),
                            "subject": info.get("subject", ""), "date": info.get("modDate", "")})
                seen(_hex(cols.get("stroke")))
            except Exception:  # noqa: BLE001
                pass
        for w in page.widgets():
            out.append({"kind": "field", "xref": w.xref, "name": w.field_name, "type": TYPE_NAMES.get(w.field_type, "text"),
                        "label": w.field_type_string, "box": _to_pdf(page, w.rect), "value": w.field_value,
                        "options": list(w.choice_values or []), "fontsize": w.text_fontsize, "flags": w.field_flags,
                        "multiline": bool(w.field_flags & pymupdf.PDF_TX_FIELD_IS_MULTILINE) if w.field_type == pymupdf.PDF_WIDGET_TYPE_TEXT else False,
                        "required": bool(w.field_flags & pymupdf.PDF_FIELD_IS_REQUIRED), "readonly": bool(w.field_flags & pymupdf.PDF_FIELD_IS_READ_ONLY),
                        "tooltip": w.field_label or "", "border": _hex(w.border_color), "bg": _hex(w.fill_color), "textcolor": _hex(w.text_color),
                        "maxlen": w.text_maxlen or 0})
        for ln in page.get_links():
            out.append({"kind": "link", "box": _to_pdf(page, ln["from"]), "uri": ln.get("uri") or "", "page": ln.get("page", -1)})
        meta = doc.metadata or {}
        swatches = [c for c, _ in sorted(colors.items(), key=lambda kv: -kv[1])][:24]
        return {"ok": True, "oggetti": out, "tracciati": paths, "troppi_disegni": len(draws) > MAX_PATHS, "pagine": len(doc),
                "metadata": {k: meta.get(k, "") for k in ("title", "author", "subject", "keywords")},
                "toc": doc.get_toc(simple=True), "size": [page.rect.width, page.rect.height], "rotation": page.rotation, "colori": swatches}


def annots_list(path: str) -> dict:
    """Tutti i commenti del documento con risposte e stato (pannello Commenti)."""
    out, replies, states = [], {}, {}
    with pymupdf.open(path) as doc:
        for page in doc:
            for a in page.annots():
                try:
                    info = a.info or {}
                    t = a.type[1]
                    if t in ("Widget", "Link", "Popup"):
                        continue
                    item = {"xref": a.xref, "page": page.number, "type": t, "box": _to_pdf(page, a.rect), "author": info.get("title", ""),
                            "contents": info.get("content", ""), "subject": info.get("subject", ""), "date": info.get("modDate", "") or info.get("creationDate", ""),
                            "color": _hex((a.colors or {}).get("stroke")) or _hex((a.colors or {}).get("fill"))}
                    if t == "Text" or t == "FreeText" or not item["contents"]:
                        pass
                    if t in ("Polygon", "Square", "Circle") and (a.border or {}).get("clouds", 0) > 0:
                        item["type"] = "Cloud"
                    if t in ("Highlight", "Underline", "StrikeOut", "Squiggly") and not item["contents"]:
                        try:
                            item["quote"] = page.get_textbox(a.rect).strip()[:200]
                        except Exception:  # noqa: BLE001
                            pass
                    if a.irt_xref:
                        st = doc.xref_get_key(a.xref, "State")
                        if st[0] == "string":
                            states[a.irt_xref] = {"state": st[1], "author": item["author"], "date": item["date"]}
                        else:
                            replies.setdefault(a.irt_xref, []).append(item)
                        continue
                    out.append(item)
                except Exception:  # noqa: BLE001
                    pass
    for it in out:
        it["replies"] = replies.get(it["xref"], [])
        it["state"] = (states.get(it["xref"]) or {}).get("state", "")
    return {"ok": True, "commenti": out}


def image_export(path: str, pno: int, xref: int, box, out: str) -> dict:
    """Salva l'immagine con i suoi pixel originali (PNG se ha una trasparenza o se il formato scelto e' diverso)."""
    with pymupdf.open(path) as doc:
        page = doc[pno]
        ext = os.path.splitext(out)[1].lower().lstrip(".")
        data, kind = None, None
        if xref:
            try:
                info = doc.extract_image(xref)
                data = _image_bytes(doc, xref, page, _from_pdf(page, box) if box else None)
                kind = "png" if data[:4] == b"\x89PNG" and data is not info["image"] else info["ext"]
            except Exception:  # noqa: BLE001
                data = None
        if data is None:
            r = _from_pdf(page, box)
            data, kind = page.get_pixmap(clip=r, dpi=200).tobytes("png"), "png"
        if ext and ext != kind and not (ext in ("jpg", "jpeg") and kind in ("jpg", "jpeg")):
            import io

            from PIL import Image
            im = Image.open(io.BytesIO(data))
            if ext in ("jpg", "jpeg") and im.mode in ("RGBA", "LA", "P"):
                bg = Image.new("RGB", im.size, (255, 255, 255))
                im = im.convert("RGBA")
                bg.paste(im, mask=im.getchannel("A"))
                im = bg
            buf = io.BytesIO()
            im.save(buf, {"jpg": "JPEG", "jpeg": "JPEG", "tif": "TIFF", "tiff": "TIFF", "bmp": "BMP", "webp": "WEBP"}.get(ext, "PNG"))
            data = buf.getvalue()
    with open(out, "wb") as f:
        f.write(data)
    return {"ok": True, "path": out}


# ---------------------------------------------------------------- utilita'
def _stencil_color(page, r, mask_png):
    """Colore con cui una maschera di stencil e' dipinta: media dei pixel della pagina dove la maschera dipinge."""
    import io

    from PIL import Image
    try:
        m = Image.open(io.BytesIO(mask_png)).getchannel("A")
        pix = page.get_pixmap(clip=r, dpi=int(72 * max(1.0, min(4.0, m.width / max(r.width, 1)))))
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).resize(m.size)
        px, al = list(im.getdata()), list(m.getdata())
        sel = [p for p, a in zip(px, al) if a > 200]
        if not sel:
            return (0, 0, 0)
        sel.sort(key=sum)  # i bordi sfumati verso lo sfondo pesano meno: si tiene la meta' piu' scura
        sel = sel[:max(1, len(sel) // 2)]
        return tuple(round(sum(p[i] for p in sel) / len(sel)) for i in range(3))
    except Exception:  # noqa: BLE001
        return (0, 0, 0)


def _image_bytes(doc, xref, page=None, r=None):
    """Immagine con la sua trasparenza, in PNG (o il flusso originale se non ne ha). Casi: maschera morbida (SMask),
    maschera esplicita o a chiave di colore (/Mask), maschera di stencil (/ImageMask: 1 bit che "dipinge" col colore
    corrente, tipico dei loghi in nero). In PyMuPDF 2 Pixmap(doc, xref) applica gia' SMask e /Mask: ricomporre
    l'immagine con la maschera falliva e il logo diventava un rettangolo nero."""
    info = doc.extract_image(xref)
    stencil = doc.xref_get_key(xref, "ImageMask")[1] == "true"
    masked = info.get("smask") or doc.xref_get_key(xref, "Mask")[0] in ("xref", "array")
    if not masked and not stencil:
        return info["image"]
    pix = pymupdf.Pixmap(doc, xref)
    if stencil:
        import io

        from PIL import Image, ImageOps
        g = Image.frombytes("L", (pix.width, pix.height), bytes(pix.samples)[:pix.width * pix.height])
        if pix.colorspace is None:  # PyMuPDF restituisce gia' l'opacita' (255 = si dipinge, Decode applicato)
            a = g
        else:
            dec = doc.xref_get_key(xref, "Decode")[1].replace(" ", "")
            a = g if dec.startswith("[1") else ImageOps.invert(g)  # campione 0 = si dipinge (Decode [0 1])
        out = Image.new("RGBA", g.size, (0, 0, 0, 0))
        out.putalpha(a)
        buf = io.BytesIO()
        out.save(buf, "PNG")
        if page is not None and r is not None:  # colore corrente con cui la maschera dipinge (letto dalla pagina)
            col = _stencil_color(page, r, buf.getvalue())
            if col != (0, 0, 0):
                out = Image.new("RGBA", g.size, col + (0,))
                out.putalpha(a)
                buf = io.BytesIO()
                out.save(buf, "PNG")
        return buf.getvalue()
    # Pixmap(doc, xref) puo' avere un canale alfa tutto opaco: la maschera si applica qui (anche se ha un'altra risoluzione)
    import io

    from PIL import Image
    if pix.alpha:
        pix = pymupdf.Pixmap(pix, 0)
    if pix.colorspace and pix.colorspace.n > 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    mode = {1: "L", 3: "RGB"}.get(pix.n, "RGB")
    base = Image.frombytes(mode, (pix.width, pix.height), bytes(pix.samples)[:pix.width * pix.height * pix.n]).convert("RGB")
    alpha = None
    mk = doc.xref_get_key(xref, "Mask")
    mxref = info.get("smask") or (int(mk[1].split()[0]) if mk[0] == "xref" else 0)
    if mxref:
        m = pymupdf.Pixmap(doc, mxref)
        if m.alpha and m.n > 1:
            m = pymupdf.Pixmap(m, 0)
        alpha = Image.frombytes("L", (m.width, m.height), bytes(m.samples)[:m.width * m.height])
        if alpha.size != base.size:
            alpha = alpha.resize(base.size, Image.BILINEAR)
    elif mk[0] == "array":  # chiave di colore: i campioni negli intervalli sono trasparenti
        rng = [int(float(v)) for v in mk[1].strip("[] ").split()]
        bands = base.split() if len(rng) >= 6 else [base.convert("L")]
        inside = None
        for i, band in enumerate(bands[:len(rng) // 2]):
            lo, hi = rng[2 * i], rng[2 * i + 1]
            b = band.point(lambda v, lo=lo, hi=hi: 255 if lo <= v <= hi else 0)
            inside = b if inside is None else Image.composite(b, Image.new("L", b.size, 0), inside)
        alpha = inside.point(lambda v: 0 if v else 255) if inside else None
    out = base.convert("RGBA")
    if alpha is not None:
        out.putalpha(alpha)
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()


def _redact(page, rect, text=True, images=False, graphics=False, fill=None):
    page.add_redact_annot(rect, fill=fill)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS if images else pymupdf.PDF_REDACT_IMAGE_NONE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED if graphics else pymupdf.PDF_REDACT_LINE_ART_NONE,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE if text else pymupdf.PDF_REDACT_TEXT_NONE)


def _same_box(a, b, tol=1.5):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def _image_count(doc, xref, page=None) -> int:
    """Quante volte un'immagine compare (logo ripetuto su ogni pagina, ecc.): posizioni sulla pagina (get_image_info,
    lento: decodifica le immagini) + pagine che la usano nelle risorse (veloce)."""
    n = sum(1 for i in page.get_image_info(xrefs=True) if i.get("xref") == xref) if page is not None else 0
    for pp in range(len(doc)):
        if n > 1:
            break
        if page is not None and pp == page.number:
            continue
        n += sum(1 for im in doc.get_page_images(pp) if im[0] == xref)
    return n


def _grab_image(doc, page, xref, r):
    """PNG/JPEG dell'immagine nel riquadro r (senza toglierla)."""
    data = None
    if xref:
        try:
            data = _image_bytes(doc, xref, page, r)
        except Exception:  # noqa: BLE001
            data = None
    if data is None:  # immagine in linea o non estraibile: si ricava dalla pagina alla sua risoluzione
        info = next((i for i in page.get_image_info() if _same_box(i["bbox"], r)), None)
        dpi = 150
        if info and r.width:
            dpi = max(72, min(600, int(72 * (info.get("width") or 1) / r.width)))
        data = page.get_pixmap(clip=r, dpi=dpi).tobytes("png")
    return data


def _take_image(doc, page, xref, r):
    """Restituisce (PNG/JPEG) l'immagine nel riquadro r e la toglie SOLO da questo punto della pagina.
    Non si usa delete_image: cambierebbe l'immagine condivisa ovunque (es. lo stesso logo sulle altre pagine)."""
    data = _grab_image(doc, page, xref, r)
    others = [i for i in page.get_image_info(xrefs=True) if not _same_box(i["bbox"], r) and pymupdf.Rect(i["bbox"]).intersects(r)]
    page.add_redact_annot(r + (-0.3, -0.3, 0.3, 0.3))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS if others else pymupdf.PDF_REDACT_IMAGE_REMOVE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_NONE)
    return data


def _process_image(data: bytes, o: dict) -> bytes:
    """Ritaglio, regolazioni (luminosita', contrasto, saturazione), bianco e nero, colori trasparenti (anche piu' di uno,
    con tolleranza), opacita', specchio, rotazione (anche non multipla di 90: gli angoli restano trasparenti)."""
    import io

    from PIL import Image, ImageChops, ImageEnhance, ImageOps
    im = Image.open(io.BytesIO(data))
    im.load()
    im = im.convert("RGBA")
    crop = o.get("crop")  # frazioni [sinistra, alto, destra, basso] da togliere
    if crop and any(float(v) > 0 for v in crop):
        w, h = im.size
        cl, ct, cr, cb = (max(0.0, min(0.95, float(v))) for v in crop)
        box = (round(w * cl), round(h * ct), max(round(w * cl) + 1, round(w * (1 - cr))), max(round(h * ct) + 1, round(h * (1 - cb))))
        im = im.crop(box)
    a = im.getchannel("A")
    rgb = im.convert("RGB")
    if o.get("brightness") not in (None, 0, "0"):
        rgb = ImageEnhance.Brightness(rgb).enhance(1 + float(o["brightness"]) / 100)
    if o.get("contrast") not in (None, 0, "0"):
        rgb = ImageEnhance.Contrast(rgb).enhance(1 + float(o["contrast"]) / 100)
    if o.get("saturation") not in (None, 0, "0"):
        rgb = ImageEnhance.Color(rgb).enhance(1 + float(o["saturation"]) / 100)
    if o.get("gray"):
        rgb = ImageOps.grayscale(rgb).convert("RGB")
    if o.get("invert"):
        rgb = ImageOps.invert(rgb)
    im = rgb.convert("RGBA")
    im.putalpha(a)
    cols = [c for c in (o.get("transparent") or []) if c]
    if cols:
        tol = max(0, min(100, float(o.get("tol", 12)))) * 2.55
        src = im.convert("RGB")
        alpha = im.getchannel("A")
        for c in cols:
            r, g, b = (int(round(v * 255)) for v in _rgb(c)[:3])
            diff = ImageChops.difference(src, Image.new("RGB", im.size, (r, g, b)))
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
    rot = float(o.get("rotate") or 0) % 360
    if rot:
        im = im.rotate(-rot, expand=True, resample=Image.BICUBIC if rot % 90 else Image.NEAREST)  # gradi in senso orario
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _rot_box(dest, angle):
    """Riquadro che contiene dest ruotato di angle gradi attorno al centro."""
    if not float(angle or 0) % 360:
        return dest
    c = (dest.tl + dest.br) / 2
    m = pymupdf.Matrix(1, 0, 0, 1, -c.x, -c.y) * pymupdf.Matrix(float(angle)) * pymupdf.Matrix(1, 0, 0, 1, c.x, c.y)
    return dest.quad.transform(m).rect


def _fit_matrix(r, dest, angle=0.0):
    """Matrice che porta il riquadro r su dest e poi ruota attorno al centro di dest (gradi orari sullo schermo)."""
    sx = dest.width / r.width if r.width else 1
    sy = dest.height / r.height if r.height else 1
    m = pymupdf.Matrix(1, 0, 0, 1, -r.x0, -r.y0) * pymupdf.Matrix(sx, 0, 0, sy, 0, 0) * pymupdf.Matrix(1, 0, 0, 1, dest.x0, dest.y0)
    if float(angle or 0) % 360:
        c = (dest.tl + dest.br) / 2
        m = m * pymupdf.Matrix(1, 0, 0, 1, -c.x, -c.y) * pymupdf.Matrix(float(angle)) * pymupdf.Matrix(1, 0, 0, 1, c.x, c.y)
    return m


def _draw_paths(page, paths, m=None, style=None, targets=None, overlay=True):
    """Ridisegna percorsi vettoriali (da get_drawings) trasformati con la matrice m.
    style: nuovo aspetto (stroke, fill, width, opacity, stroke_opacity, fill_opacity, dash, cap) per i tracciati in
    targets (None = tutti)."""
    m = m or pymupdf.Identity
    k = abs(m.a * m.d - m.b * m.c) ** 0.5 or 1
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
            if style.get("stroke_opacity") is not None:
                path["stroke_opacity"] = float(style["stroke_opacity"])
            if style.get("fill_opacity") is not None:
                path["fill_opacity"] = float(style["fill_opacity"])
            if "dash" in style or "dashed" in style:
                kind = style.get("dash", "dash" if style.get("dashed") else "")
                path["dashes"] = _dashes(kind, path.get("width"))
            if style.get("cap") is not None:
                path["lineCap"] = int(style["cap"])
            if path.get("color") is None and path.get("fill") is None:
                continue  # ne' bordo ne' riempimento: tracciato invisibile
        if path.get("color") is None and path.get("fill") is None:
            continue
        for it in path["items"]:
            op = it[0]
            if op == "l":
                shape.draw_line(it[1] * m, it[2] * m)
            elif op == "c":
                shape.draw_bezier(it[1] * m, it[2] * m, it[3] * m, it[4] * m)
            elif op == "re":
                shape.draw_quad(pymupdf.Rect(it[1]).quad.transform(m))
            elif op == "qu":
                shape.draw_quad(pymupdf.Quad(it[1]).transform(m))
        cap = path.get("lineCap")
        shape.finish(color=path.get("color"), fill=path.get("fill"), width=(path.get("width") or 1) * k,
                     closePath=path.get("closePath", False), even_odd=path.get("even_odd", False),
                     lineCap=max(cap or [0]) if isinstance(cap, (list, tuple)) else (cap or 0),
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


_DRAW_CACHE: dict = {}  # (file, data, dimensione, pagina) -> tracciati: le tavole CAD pesanti si leggono una volta sola


def _cached_draws(path, pno, page):
    st = os.stat(path)
    key = (path, st.st_mtime_ns, st.st_size, pno)
    if key not in _DRAW_CACHE:
        while len(_DRAW_CACHE) >= 4:
            _DRAW_CACHE.pop(next(iter(_DRAW_CACHE)))
        _DRAW_CACHE[key] = _page_draws(page)
    return _DRAW_CACHE[key]


def _seg_dist(p, a, b):
    ab, ap = b - a, p - a
    L = ab.x * ab.x + ab.y * ab.y
    t = 0 if L == 0 else max(0.0, min(1.0, (ap.x * ab.x + ap.y * ab.y) / L))
    return abs(p - (a + ab * t))


def _path_dist(d, p):
    """Distanza del punto p dal tracciato (0 se dentro un tracciato riempito)."""
    if d.get("fill") is not None and pymupdf.Rect(d["rect"]).contains(p):
        return 0.0
    best = 1e9
    for it in d["items"]:
        if it[0] == "l":
            best = min(best, _seg_dist(p, it[1], it[2]))
        elif it[0] == "c":
            pts = [it[1], it[2], it[3], it[4]]
            best = min(best, *(_seg_dist(p, a, b) for a, b in zip(pts, pts[1:])))
        elif it[0] in ("re", "qu"):
            q = pymupdf.Rect(it[1]).quad if it[0] == "re" else pymupdf.Quad(it[1])
            pts = [q.ul, q.ur, q.lr, q.ll, q.ul]
            best = min(best, *(_seg_dist(p, a, b) for a, b in zip(pts, pts[1:])))
    return best


def _draw_obj(page, d):
    return {"kind": "drawing", "seqno": d.get("seqno"), "box": _to_pdf(page, d["rect"]), "stroke": _hex(d.get("color")), "fill": _hex(d.get("fill")),
            "width": round(d.get("width") or 0, 2), "opacity": d.get("fill_opacity") if d.get("fill") else d.get("stroke_opacity"),
            "dash": _dash_kind(d.get("dashes")), "dashed": bool(_dash_kind(d.get("dashes")))}


def paths_hit(path: str, pno: int, point=None, box=None, tol: float = 3.0) -> dict:
    """Disegni troppo densi per essere elencati (tavole CAD): tracciati sotto il punto cliccato (i piu' vicini prima) o
    contenuti nel riquadro di selezione (restituiti come un gruppo)."""
    with pymupdf.open(path) as doc:
        page = doc[pno]
        draws = _cached_draws(path, pno, page)
        if point is not None:
            p = pymupdf.Point(point) * page.transformation_matrix
            near = []
            for d in draws:
                r = pymupdf.Rect(d["rect"]) + (-tol - (d.get("width") or 0), -tol - (d.get("width") or 0), tol + (d.get("width") or 0), tol + (d.get("width") or 0))
                if not r.contains(p):
                    continue
                dist = _path_dist(d, p)
                if dist <= tol + (d.get("width") or 0) / 2:
                    near.append((dist, abs(pymupdf.Rect(d["rect"])), d))
            near.sort(key=lambda x: (round(x[0], 1), x[1]))
            return {"ok": True, "tracciati": [_draw_obj(page, d) for _, _, d in near[:12]]}
        r = _from_pdf(page, box)
        inside = [d for d in draws if pymupdf.Rect(d["rect"]) in r + (-0.6, -0.6, 0.6, 0.6)]
        if not inside:
            return {"ok": True, "gruppo": None}
        u = pymupdf.Rect(inside[0]["rect"])
        for d in inside[1:]:
            u |= d["rect"]
        strokes = [_hex(d.get("color")) for d in inside if d.get("color")]
        return {"ok": True, "gruppo": {"kind": "group", "box": _to_pdf(page, u), "n": len(inside), "stroke": max(set(strokes), key=strokes.count) if strokes else None,
                                        "fill": None, "width": round(max((d.get("width") or 0) for d in inside), 2), "dash": ""}}


def _paths_in(page, rect, tol=0.6):
    big = rect + (-tol, -tol, tol, tol)
    return [p for p in _page_draws(page) if pymupdf.Rect(p["rect"]) in big]


def _cut_paths(page, r):
    """Toglie dalla pagina i tracciati contenuti nel riquadro r e li restituisce (quelli estranei che toccano la zona
    vengono ridisegnati identici). La zona include mezzo spessore del bordo: altrimenti i tratti spessi restano."""
    alld = _page_draws(page)  # una sola lettura (sulle tavole CAD costa secondi)
    first = [p for p in alld if pymupdf.Rect(p["rect"]) in r + (-0.6, -0.6, 0.6, 0.6)]
    m = max([(p.get("width") or 0) for p in first] + [0]) / 2 + 1
    zone = r + (-m, -m, m, m)
    # MuPDF non toglie i tracciati racchiusi in un altro ("coperti"): si tolgono quelli che toccano la zona
    # e si ridisegnano identici quelli che non fanno parte del gruppo
    touched = [p for p in alld if (pymupdf.Rect(p["rect"]) + (-0.05, -0.05, 0.05, 0.05)).intersects(zone)]
    strangers = [p for p in touched if pymupdf.Rect(p["rect"]) not in zone]
    paths = [p for p in touched if pymupdf.Rect(p["rect"]) in zone]
    page.add_redact_annot(zone)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                          text=pymupdf.PDF_REDACT_TEXT_NONE)
    if strangers:
        _draw_paths(page, strangers, overlay=False)
    return paths


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


# ---- testo: carattere incorporato nel PDF, se contiene tutti i caratteri del testo nuovo
_EMB_CACHE: dict = {}


def _font_key(name):
    """'ABCDEF+Arial-BoldMT' -> ('arial', grassetto, corsivo) per abbinare il nome di una porzione di testo a quello
    del carattere nella pagina (possono essere scritti in modo diverso: ArialMT / Arial Regular)."""
    n = (name or "").split("+")[-1].lower()
    fam = re.split(r"[\s,\-]", n)[0]
    fam = re.sub(r"(mt|ps|regular|bold|italic|oblique)+$", "", fam) or fam
    return fam, "bold" in n or "black" in n, "italic" in n or "oblique" in n


def _tounicode(doc, font_xref):
    """Tabella ToUnicode del carattere: {codice: testo}."""
    tu = doc.xref_get_key(font_xref, "ToUnicode")
    if tu[0] != "xref":
        return {}
    data = doc.xref_stream(int(tu[1].split()[0])).decode("latin-1")
    out = {}
    hexs = lambda h: bytes.fromhex(h).decode("utf-16-be", "ignore")  # noqa: E731
    for blk in re.findall(r"beginbfchar(.*?)endbfchar", data, re.S):
        for a, b in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", blk):
            out[int(a, 16)] = hexs(b)
    for blk in re.findall(r"beginbfrange(.*?)endbfrange", data, re.S):
        for a, b, rest in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)", blk):
            lo, hi = int(a, 16), int(b, 16)
            if rest.startswith("["):
                for i, h in enumerate(re.findall(r"<([0-9A-Fa-f]+)>", rest)):
                    out[lo + i] = hexs(h)
            else:
                base = int(rest[1:-1], 16)
                for i in range(min(hi - lo + 1, 65536)):
                    out[lo + i] = chr(base + i) if base + i < 0x110000 else ""
    return out


def _font_with_cmap(doc, font_xref, buf):
    """I caratteri incorporati come sottoinsieme non hanno la tabella cmap (Unicode -> glifo) e non si possono usare per
    scrivere: si ricostruisce dalla ToUnicode del PDF (codice CID -> glifo con CIDToGIDMap) con fontTools."""
    import io

    from fontTools.ttLib import TTFont, newTable
    from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
    codes = _tounicode(doc, font_xref)
    if not codes:
        return None
    tt = TTFont(io.BytesIO(buf), lazy=False)
    order = tt.getGlyphOrder()
    sub = doc.xref_get_key(font_xref, "Subtype")[1]
    cid2gid = None
    if sub == "/Type0":
        desc = doc.xref_get_key(font_xref, "DescendantFonts")
        m = re.search(r"(\d+)\s+0\s+R", desc[1])
        if m:
            g = doc.xref_get_key(int(m.group(1)), "CIDToGIDMap")
            if g[0] == "xref":
                raw = doc.xref_stream(int(g[1].split()[0]))
                cid2gid = lambda c: int.from_bytes(raw[2 * c:2 * c + 2], "big") if 2 * c + 2 <= len(raw) else 0  # noqa: E731
        gid_of = cid2gid or (lambda c: c)
    else:  # TrueType semplice: codice -> glifo con la cmap (3,0) / (1,0) del carattere, se c'e'
        old = {}
        if "cmap" in tt:
            for t in tt["cmap"].tables:
                for code, name in t.cmap.items():
                    old.setdefault(code & 0xFF, name)
        gid_of = lambda c: order.index(old[c]) if c in old else 0  # noqa: E731
    uni = {}
    for code, text in codes.items():
        if len(text) != 1:
            continue
        gid = gid_of(code)
        if 0 < gid < len(order):
            uni.setdefault(ord(text), order[gid])
    if not uni:
        return None
    cm = newTable("cmap")
    cm.tableVersion = 0
    cm.tables = []
    for fmt, enc, lim in ((4, 1, 0xFFFF), (12, 10, 0x10FFFF)):
        st = CmapSubtable.newSubtable(fmt)
        st.platformID, st.platEncID, st.language = 3, enc, 0
        st.cmap = {u: n for u, n in uni.items() if u <= lim}
        if st.cmap and (fmt == 4 or any(u > 0xFFFF for u in uni)):
            cm.tables.append(st)
    tt["cmap"] = cm
    out = io.BytesIO()
    tt.save(out)
    return pymupdf.Font(fontbuffer=out.getvalue())


def _embedded_font(doc, page, name, text):
    want = _font_key(name)
    for f in page.get_fonts(full=True):
        xref, ext = f[0], f[1]
        if ext in ("n/a", "") or not xref or _font_key(f[3]) != want:
            continue
        key = (id(doc), xref)
        if key not in _EMB_CACHE:
            font = None
            try:
                buf = doc.extract_font(xref)[3]
                if buf:
                    font = pymupdf.Font(fontbuffer=buf)
                    if not font.has_glyph(ord("e")) and ext == "ttf":
                        font = _font_with_cmap(doc, xref, buf) or font
            except Exception:  # noqa: BLE001
                font = None
            _EMB_CACHE[key] = font
        font = _EMB_CACHE[key]
        if font and all(font.has_glyph(ord(ch)) for ch in text if not ch.isspace()):
            return font
    return None


def _block_font(doc, page, o, text):
    if o.get("keep_font", True) and o.get("font"):
        f = _embedded_font(doc, page, o["font"], text)
        if f is not None:
            return f
    return _font(o.get("font", ""), bool(o.get("bold")), bool(o.get("italic")))


def _layout(font, text, size, width, align):
    """Righe del paragrafo con a capo automatico nella larghezza data: [(parole, larghezza, ultima riga del paragrafo)]."""
    sp = font.text_length(" ", size)
    out = []
    for para in text.split("\n"):
        words = para.split(" ")
        line, lw = [], 0.0
        for w in words:
            ww = font.text_length(w, size)
            if line and lw + sp + ww > width:
                out.append((line, lw, False))
                line, lw = [w], ww
            else:
                lw = lw + sp + ww if line else ww
                line.append(w)
        out.append((line, lw, True))
    return out


def _write_block(doc, page, dest, o, text, angle=0.0, overlay=True, src_page=None):
    """Paragrafo (a capo automatico nella larghezza di dest, allineamento sinistra/centro/destra/giustificato, interlinea)
    scritto con TextWriter e ruotato attorno al centro. Le righe si compongono qui: fill_textbox di PyMuPDF scrive
    spazi non separabili e il testo modificato non si troverebbe piu' con la ricerca."""
    text = text.replace("\t", "   ")  # rientro dopo il pallino degli elenchi
    f = _block_font(doc, src_page or page, o, text)
    size = float(o.get("size") or 11)
    lh = float(o.get("lineheight") or 1.15) * size
    align = int(o.get("align", 0))
    # impaginazione nel verso di lettura (pagina come si vede); le posizioni si riportano attorno al centro c del
    # riquadro nel sistema della pagina e la rotazione (pagina ruotata + rotazione dell'oggetto) la fa morph
    # verso del testo originale (dir della prima riga, sistema della pagina): una riga verticale resta verticale
    R = page.rotation
    base = 0.0
    if o.get("dir"):
        import math
        base = (math.degrees(math.atan2(float(o["dir"][1]), float(o["dir"][0]))) + R) % 360
        if abs(base - round(base / 90) * 90) < 1:
            base = round(base / 90) * 90 % 360
    angle = base + float(angle or 0)
    dv = dest * page.rotation_matrix if R else pymupdf.Rect(dest)
    dv.normalize()
    cv = (dv.tl + dv.br) / 2
    c = (dest.tl + dest.br) / 2
    if base in (90, 270):  # riquadro della riga verticale: larghezza e altezza scambiate
        dv = pymupdf.Rect(cv.x - dv.height / 2, cv.y - dv.width / 2, cv.x + dv.height / 2, cv.y + dv.width / 2)
    width = max(dv.width, 20)
    if o.get("fit"):  # titolo / riga singola: il riquadro si allarga invece di andare a capo
        need = max(f.text_length(t, size) for t in text.split("\n"))
        if need > width:
            grow = need - width
            if align == 1:
                dv = pymupdf.Rect(dv.x0 - grow / 2, dv.y0, dv.x1 + grow / 2, dv.y1)
            elif align == 2:
                dv = pymupdf.Rect(dv.x0 - grow, dv.y0, dv.x1, dv.y1)
            else:
                dv = pymupdf.Rect(dv.x0, dv.y0, dv.x1 + grow, dv.y1)
            width = need + 0.5
    tw = pymupdf.TextWriter(page.rect, color=_rgb(o.get("color")))
    put = lambda x, y, s: tw.append(c + (pymupdf.Point(x, y) - cv), s, font=f, fontsize=size)  # noqa: E731
    y = dv.y0 + f.ascender * size
    sp = f.text_length(" ", size)
    for words, lw, last in _layout(f, text, size, width, align):
        if align == 3 and not last and len(words) > 1:  # giustificato: spazi distribuiti
            gap = sp + (width - lw) / (len(words) - 1)
            x = dv.x0
            for w in words:
                put(x, y, w)
                x += f.text_length(w, size) + gap
        else:
            put(dv.x0 + {1: (width - lw) / 2, 2: width - lw}.get(align, 0), y, " ".join(words))
        y += lh
    rot = (R - float(angle or 0)) % 360  # TextWriter ruota in verso antiorario
    morph = (c, pymupdf.Matrix(rot)) if rot else None
    tw.write_text(page, overlay=overlay, morph=morph, opacity=float(o["opacity"]) if o.get("opacity") is not None else -1)


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
    if o.get("maxlen") is not None and w.field_type == pymupdf.PDF_WIDGET_TYPE_TEXT:
        w.text_maxlen = int(o["maxlen"] or 0)
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
    if "bg" in o:
        w.fill_color = _rgb(o["bg"], None)
    if "fill" in o:
        w.fill_color = _rgb(o["fill"], None)
    if o.get("textcolor"):
        w.text_color = _rgb(o["textcolor"])


def _now():
    return pymupdf.get_pdf_now()


def _annot_common(a, o):
    now = _now()
    info = {"title": o.get("author") or "MB Desk", "creationDate": now, "modDate": now}
    if o.get("subject"):
        info["subject"] = o["subject"]
    if o.get("contents") is not None:
        info["content"] = o["contents"]
    a.set_info(**info)


# ---------------------------------------------------------------- operazioni
def apply_ops(path: str, ops: list[dict]) -> dict:
    """Applica le operazioni e sostituisce il file. Le operazioni girano in una funzione a parte: campi, pagine e
    annotazioni di PyMuPDF ancora in memoria tengono aperto il file anche a documento chiuso e Windows ne rifiuta
    la sostituzione; finita la funzione si liberano (gc) e la sostituzione si ritenta per qualche istante."""
    import gc
    import time
    tmp = path + ".mbv-ops.pdf"
    info: dict = {}
    try:
        done = _apply_ops(path, tmp, ops, info)
        _EMB_CACHE.clear()
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
    return {"ok": True, "operazioni": done, **info}


def _apply_ops(path: str, tmp: str, ops: list[dict], info: dict) -> int:
    from . import pdfdoc
    done = 0
    with pymupdf.open(path) as doc:
        n0 = doc.xref_length()
        for o in ops:
            k = o["kind"]
            if k in pdfdoc.OPS:
                pdfdoc.OPS[k](doc, o, info)
                done += 1
                continue
            page = doc[int(o["page"])] if "page" in o and o["page"] is not None else None
            r = _from_pdf(page, o["box"]) if page is not None and o.get("box") else None
            if r is None and page is not None and k.startswith("image_") and o.get("xref"):
                # richiesta senza riquadro: si usa la posizione dell'immagine sulla pagina
                hit = next((i for i in page.get_image_info(xrefs=True) if i.get("xref") == int(o["xref"])), None)
                r = pymupdf.Rect(hit["bbox"]) if hit else None
            to = _from_pdf(page, o["to"]) if page is not None and o.get("to") else None
            angle = float(o.get("rotate_obj") or 0)

            if k == "text_block":
                # blocco di testo riscritto (anche su piu' righe, con a capo automatico) nello stesso posto, spostato o ruotato
                src_page = page
                _redact(page, r + (-0.5, -0.5, 0.5, 0.5), text=True)
                text = o.get("text", "")
                if text.strip():
                    _write_block(doc, page, to or r, o, text, angle, src_page=src_page)
            elif k == "typewriter":
                # macchina da scrivere: testo vero nella pagina, dal punto cliccato (linea di base della prima riga)
                p = pymupdf.Point(o["at"][0], o["at"][1]) * page.transformation_matrix
                pv = p * page.rotation_matrix if page.rotation else p
                f = _font(o.get("font", "Helvetica"), bool(o.get("bold")), bool(o.get("italic")))
                size = float(o.get("size") or 11)
                dv = pymupdf.Rect(pv.x, pv.y - f.ascender * size, pv.x + 5000, pv.y + 5000)
                _write_block(doc, page, dv * page.derotation_matrix if page.rotation else dv, {**o, "keep_font": False, "lineheight": o.get("lineheight", 1.2)},
                             o.get("text", ""))
            elif k == "image_add":
                data = base64.b64decode(o["data"])
                page.insert_image(r, stream=data, keep_proportion=bool(o.get("keep", True)), rotate=int(o.get("rotate", 0)))
            elif k == "image_move":
                data = _take_image(doc, page, int(o.get("xref") or 0), r)
                dest = to or r
                if angle % 360:
                    data = _process_image(data, {"rotate": angle})
                    dest = _rot_box(dest, angle)
                page.insert_image(dest, stream=data, keep_proportion=False)
            elif k == "image_replace":
                data = base64.b64decode(o["data"])
                _take_image(doc, page, int(o.get("xref") or 0), r)
                page.insert_image(r, stream=data, keep_proportion=bool(o.get("keep", True)))
            elif k == "image_delete":
                _take_image(doc, page, int(o.get("xref") or 0), r)
            elif k == "image_edit":
                # ritaglio, regolazioni, trasparenze, opacita', rotazione, specchio, bianco e nero
                xref = int(o.get("xref") or 0)
                rot = float(o.get("rotate") or 0) % 360
                crop = o.get("crop")
                dest = to or r
                if crop and any(float(v) > 0 for v in crop):  # il riquadro si restringe come l'immagine
                    cl, ct, cr, cb = (float(v) for v in crop)
                    dest = pymupdf.Rect(dest.x0 + dest.width * cl, dest.y0 + dest.height * ct, dest.x1 - dest.width * cr, dest.y1 - dest.height * cb)
                if xref and not to and not rot and not (crop and any(float(v) > 0 for v in crop)) and _image_count(doc, xref, page) == 1:
                    # stessa posizione e immagine usata una volta sola: si sostituisce sul posto (resta sotto/sopra come prima)
                    page.replace_image(xref, stream=_process_image(_image_bytes(doc, xref, page, r), o))
                else:
                    data = _process_image(_take_image(doc, page, xref, r), o)
                    if rot in (90, 270):  # riquadro ruotato attorno al centro
                        c = (dest.tl + dest.br) / 2
                        dest = pymupdf.Rect(c.x - dest.height / 2, c.y - dest.width / 2, c.x + dest.height / 2, c.y + dest.width / 2)
                    elif rot:
                        dest = _rot_box(dest, rot)
                    page.insert_image(dest, stream=data, keep_proportion=False)
            elif k in ("draw_move", "draw_delete", "draw_edit"):
                # gruppo o singolo tracciato: si tolgono i tracciati contenuti nel riquadro e si ridisegnano
                # (spostati / ruotati / con il nuovo aspetto); quelli non scelti tornano identici
                paths = _cut_paths(page, r)
                targets = set(o["targets"]) if o.get("targets") else None
                if k == "draw_delete" or o.get("delete"):
                    paths = [p for p in paths if targets is not None and p.get("seqno") not in targets]
                    to = None
                    angle = 0
                if paths:
                    dest = to or r
                    m = _fit_matrix(r, dest, angle)
                    # sotto testi e immagini (sfondi, tabelle), salvo che il gruppo stia sopra un'immagine
                    over = any(pymupdf.Rect(i["bbox"]).intersects(dest) for i in page.get_image_info())
                    if targets is not None and (to is not None or angle):  # singoli tracciati spostati: gli altri restano fermi
                        _draw_paths(page, [p for p in paths if p.get("seqno") not in targets], overlay=over)
                        _draw_paths(page, [p for p in paths if p.get("seqno") in targets], m, style=o.get("style"), overlay=over)
                    else:
                        _draw_paths(page, paths, m, style=o.get("style"), targets=targets, overlay=over)
            elif k == "obj_order":
                # in primo piano (sopra tutto il contenuto) o in fondo (sotto tutto)
                front = o.get("where", "front") == "front"
                ok_ = o.get("obj", "")
                if ok_ == "image":
                    data = _take_image(doc, page, int(o.get("xref") or 0), r)
                    page.insert_image(r, stream=data, keep_proportion=False, overlay=front)
                elif ok_ in ("group", "drawing"):
                    paths = _cut_paths(page, r)
                    targets = set(o["targets"]) if o.get("targets") else None
                    if targets is not None:
                        _draw_paths(page, [p for p in paths if p.get("seqno") not in targets], overlay=True)
                        paths = [p for p in paths if p.get("seqno") in targets]
                    _draw_paths(page, paths, overlay=front)
                elif ok_ == "text":
                    _redact(page, r + (-0.5, -0.5, 0.5, 0.5), text=True)
                    _write_block(doc, page, r, o, o.get("text", ""), overlay=front)
            elif k == "obj_copy":
                # copia (anche su un'altra pagina): immagini, disegni e testi restano quelli originali
                dst = doc[int(o.get("to_page", o["page"]))]
                dest = _from_pdf(dst, o["to"]) if o.get("to") else r
                ok_ = o.get("obj", "")
                if ok_ == "image":
                    dst.insert_image(dest, stream=_grab_image(doc, page, int(o.get("xref") or 0), r), keep_proportion=False)
                elif ok_ in ("group", "drawing"):
                    paths = _paths_in(page, r)
                    if o.get("targets"):
                        paths = [p for p in paths if p.get("seqno") in set(o["targets"])]
                    _draw_paths(dst, paths, _fit_matrix(r, dest))
                elif ok_ == "text":
                    _write_block(doc, dst, dest, o, o.get("text", ""), src_page=page)
                elif ok_ == "annot":
                    a = _find_annot(page, o["xref"])
                    if a:
                        _copy_annot(page, a, dst, dest)
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
                    if p.get("width") is not None or p.get("dash") is not None:
                        try:
                            a.set_border(width=float(p["width"]) if p.get("width") is not None else -1,
                                         dashes=[3, 2] if p.get("dash") == "dash" else ([1, 2] if p.get("dash") == "dot" else ([] if p.get("dash") == "" else None)))
                        except Exception:  # noqa: BLE001
                            pass
                    inf = {}
                    if "contents" in p:
                        inf["content"] = p["contents"]
                    if "author" in p:
                        inf["title"] = p["author"]
                    if "subject" in p:
                        inf["subject"] = p["subject"]
                    if inf:
                        a.set_info(**inf, modDate=_now())
                    if p.get("icon"):
                        try:
                            a.set_name(p["icon"])
                        except Exception:  # noqa: BLE001
                            pass
                    if to:
                        try:
                            a.set_rect(to)
                        except Exception:  # noqa: BLE001
                            pass
                    a.update()
            elif k == "annot_delete":
                a = _find_annot(page, o["xref"])
                if a:
                    for b in list(page.annots()):  # risposte e stati del commento
                        if b.irt_xref == a.xref:
                            page.delete_annot(b)
                    a = _find_annot(page, o["xref"])
                    if a:
                        page.delete_annot(a)
            elif k == "annot_add":
                _annot_add(page, r, o)
            elif k == "annot_reply":
                par = _find_annot(page, o["xref"])
                if par:
                    a = page.add_text_annot(par.rect.tl, o.get("text", ""), icon="Comment")
                    a.set_irt_xref(par.xref)
                    a.set_info(title=o.get("author") or "MB Desk", content=o.get("text", ""), creationDate=_now(), modDate=_now())
                    a.set_flags(pymupdf.PDF_ANNOT_IS_PRINT | pymupdf.PDF_ANNOT_IS_NO_ZOOM | pymupdf.PDF_ANNOT_IS_NO_ROTATE | pymupdf.PDF_ANNOT_IS_HIDDEN)
                    a.update()
            elif k == "annot_state":
                par = _find_annot(page, o["xref"])
                if par:
                    for b in list(page.annots()):
                        if b.irt_xref == par.xref and doc.xref_get_key(b.xref, "State")[0] == "string":
                            page.delete_annot(b)
                    st = o.get("state", "None")
                    if st in STATES and st != "None":
                        par = _find_annot(page, o["xref"])
                        a = page.add_text_annot(par.rect.tl, "", icon="Comment")
                        a.set_irt_xref(par.xref)
                        a.set_info(title=o.get("author") or "MB Desk", content=st, creationDate=_now(), modDate=_now())
                        a.set_flags(pymupdf.PDF_ANNOT_IS_HIDDEN)
                        a.update()
                        doc.xref_set_key(a.xref, "State", _pdf_str(st))
                        doc.xref_set_key(a.xref, "StateModel", "(Review)")
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
                           dashes=_dashes(o.get("dash", "dash" if o.get("dashed") else ""), o.get("width")),
                           fill_opacity=float(o.get("fill_opacity", o.get("opacity", 1))), stroke_opacity=float(o.get("opacity", 1)))
                shp.commit()
            elif k == "field_add":
                # in PyMuPDF 2 il campo nasce con un oggetto genitore: nome, flag, voci e colori si impostano PRIMA di add_widget
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
                _set_widget(w, {key: v for key, v in o.items() if key in ("tooltip", "required", "readonly", "multiline", "editable", "bg", "textcolor", "maxlen")})
                if o.get("value") not in (None, "") and o.get("type") not in ("check", "radio", "signature"):
                    w.field_value = o["value"]
                page.add_widget(w)
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
            elif k == "redact_mark":
                # oscuramento segnato (riquadro rosso): diventa definitivo con redact_apply, come in Acrobat
                a = page.add_redact_annot(r, text=o.get("overlay") or None, fill=_rgb(o.get("fill") or "#000000"))
                a.set_info(title=o.get("author") or "MB Desk")
                a.update()
            else:
                raise ValueError(tr("srv_pdfobjects.operazione_sconosciuta_0", k))
            done += 1
        try:
            doc.subset_fonts()
        except Exception:  # noqa: BLE001
            pass
        fix_tounicode(doc, n0)
        doc.save(tmp, garbage=3, deflate=True)
    return done


def _annot_add(page, r, o):
    """Commenti nuovi: note, testo evidenziato/sottolineato/barrato/ondulato, casella di testo, forme (rettangolo, ellisse,
    linea, freccia, poligono, nuvola di revisione), timbro di testo."""
    t = o.get("type", "underline")
    defaults = {"underline": "#1565c0", "strikeout": "#d32f2f", "squiggly": "#d32f2f", "highlight": "#ffeb3b", "note": "#ffcc00"}
    col = _rgb(o.get("color") or defaults.get(t, "#d32f2f"))
    fill = _rgb(o.get("fill"), None)
    width = float(o.get("width") or 1.5)
    if t == "note":
        a = page.add_text_annot(r.tl, o.get("text", ""), icon=o.get("icon") or "Comment")
        a.set_colors(stroke=col)
    elif t in ("underline", "strikeout", "squiggly", "highlight"):
        words = page.get_text("words", clip=r)
        if not words:
            raise ValueError(tr("srv_pdfobjects.nessun_testo_riquadro_trascina_sopra"))
        quads = [pymupdf.Rect(w[:4]).quad for w in words]
        a = {"underline": page.add_underline_annot, "strikeout": page.add_strikeout_annot,
             "squiggly": page.add_squiggly_annot, "highlight": page.add_highlight_annot}[t](quads)
        a.set_colors(stroke=col)
    elif t == "freetext":
        a = page.add_freetext_annot(r, o.get("text", ""), fontsize=float(o.get("size") or 11), fontname="Helv",
                                    text_color=_rgb(o.get("textcolor") or "#000000"), fill_color=fill,
                                    border_width=width if o.get("border", True) else 0)
    elif t in ("rect", "ellipse"):
        a = page.add_rect_annot(r) if t == "rect" else page.add_circle_annot(r)
        a.set_colors(stroke=col, fill=fill)
        a.set_border(width=width, dashes=[3, 2] if o.get("dash") == "dash" else None)
    elif t in ("line", "arrow"):
        p1 = pymupdf.Point(o["p1"]) * page.transformation_matrix
        p2 = pymupdf.Point(o["p2"]) * page.transformation_matrix
        a = page.add_line_annot(p1, p2)
        a.set_colors(stroke=col, fill=col)
        a.set_border(width=width)
        if t == "arrow":
            a.set_line_ends(pymupdf.PDF_ANNOT_LE_NONE, pymupdf.PDF_ANNOT_LE_OPEN_ARROW)
    elif t in ("polygon", "cloud"):
        pts = [pymupdf.Point(p) * page.transformation_matrix for p in o["points"]] if o.get("points") else [r.tl, r.tr, r.br, r.bl]
        a = page.add_polygon_annot(pts)
        a.set_colors(stroke=col, fill=fill)
        a.set_border(width=width, clouds=2 if t == "cloud" else -1)
    elif t == "stamp":
        a = _stamp_annot(page, r, o)
    else:
        raise ValueError(tr("srv_pdfobjects.operazione_sconosciuta_0", t))
    if o.get("opacity") is not None:
        a.set_opacity(float(o["opacity"]))
    _annot_common(a, {**o, "contents": o.get("contents", o.get("text") if t in ("note", "freetext", "stamp") else o.get("contents"))})
    a.update()
    return a


def _stamp_annot(page, r, o):
    """Timbro (APPROVATO, BOZZA...) come annotazione Stamp: riquadro arrotondato, testo grande e riga piccola (autore e
    data) nel colore scelto, disegnati in un'immagine trasparente ad alta risoluzione; oppure un'immagine scelta."""
    if o.get("image"):
        a = page.add_stamp_annot(r, stamp=base64.b64decode(o["image"]))
        a.set_info(subject=o.get("text") or "Stamp")
        return a
    col = _rgb(o.get("color") or "#c62828")
    title = (o.get("text") or "").upper()
    sub = o.get("sub") or ""
    with pymupdf.open() as tmp:
        p = tmp.new_page(width=r.width, height=r.height)
        rr = p.rect + (2, 2, -2, -2)
        sh = p.new_shape()
        sh.draw_rect(rr, radius=0.12)
        sh.finish(color=col, width=2.2, fill=None)
        sh.commit()
        f = pymupdf.Font("hebo")
        fs = min(rr.height * (0.5 if sub else 0.62), (rr.width - 12) / max(1, f.text_length(title, 1)))
        tw = pymupdf.TextWriter(p.rect, color=col)
        y = rr.y0 + rr.height * (0.55 if sub else 0.5) + fs * 0.35
        tw.append(((r.width - f.text_length(title, fs)) / 2, y), title, font=f, fontsize=fs)
        if sub:
            f2 = pymupdf.Font("helv")
            fs2 = min(rr.height * 0.18, (rr.width - 12) / max(1, f2.text_length(sub, 1)))
            tw.append(((r.width - f2.text_length(sub, fs2)) / 2, rr.y1 - fs2 * 0.7), sub, font=f2, fontsize=fs2)
        tw.write_text(p)
        png = p.get_pixmap(dpi=288, alpha=True).tobytes("png")
    a = page.add_stamp_annot(r, stamp=png)
    a.set_info(subject=o.get("text") or "Stamp")
    return a


def _copy_annot(src_page, a, dst, dest):
    """Copia di un commento semplice (nota, forme, testo libero) su un'altra pagina."""
    t = a.type[1]
    info = a.info or {}
    cols = a.colors or {}
    if t == "Text":
        b = dst.add_text_annot(dest.tl, info.get("content", ""))
    elif t == "Square":
        b = dst.add_rect_annot(dest)
    elif t == "Circle":
        b = dst.add_circle_annot(dest)
    elif t == "FreeText":
        b = dst.add_freetext_annot(dest, info.get("content", ""))
    else:
        return
    b.set_colors(stroke=cols.get("stroke"), fill=cols.get("fill"))
    b.set_info(title=info.get("title", ""), content=info.get("content", ""))
    if a.opacity >= 0:
        b.set_opacity(a.opacity)
    b.update()
