"""Converti in disegno: PDF vettoriali, PDF scansionati e immagini -> DXF (o DWG con ODA File Converter).

- PDF vettoriali: mbvisual/pdfvec.py (tracciati e testi della pagina).
- Scansioni e immagini: mbvisual/rastervec.py (pulizia, vettorizzazione propria, OCR di Windows). Risultato approssimato.

Formato neutro delle entita' (unita' della sorgente: punti PDF o pixel, y verso l'alto):
  line {p:[x1,y1,x2,y2]}  arc {c:[x,y], r, a:[inizio, fine] gradi antiorari}  circle {c, r}
  poly {v:[[x,y,bulge]...], closed}  spline {cp:[[x,y]...] Bezier cubiche concatenate (3n+1 punti)}
  hatch {paths:[[[x,y,bulge]...]...], alpha?}  text {p, h, rot, s, font, bold, italic, file, wf}
  mtext {p (alto a sinistra), h, rot, lines:[...], spacing}
  comuni: L (layer), col (colore 0xRRGGBB o None), lw (spessore in 1/100 mm, -3 = predefinito), lt (tratteggio)
Le pagine si posano nello spazio modello affiancate (unita' reali secondo la scala); con "fogli" ogni pagina ha anche un
layout con la dimensione della carta e una finestra in scala sulla sua parte di modello.
"""
import hashlib
import json
import math
import os
from pathlib import Path

from .i18n import t as tr
from .paths import TEMP_DIR

UNITS = {"mm": (1.0, 4), "cm": (10.0, 5), "m": (1000.0, 6), "in": (25.4, 1)}
PREVIEW_DIR = TEMP_DIR / "disegno"
PDF_EXT = {"pdf"}


def _ext(p):
    return Path(p).suffix.lower().lstrip(".")


# ---------------------------------------------------------------- informazioni sul file
def info(path: str) -> dict:
    """Pagine, tipo di contenuto (vettoriale / scansione), layer OCG, scale trovate nel testo."""
    ext = _ext(path)
    if ext in PDF_EXT:
        import pymupdf
        from . import pdfvec
        with pymupdf.open(path) as doc:
            if doc.needs_pass:
                raise RuntimeError(tr("srv_drawing.pdf_protetto"))
            pages = []
            for i, p in enumerate(doc):
                if i < 60:
                    pi = pdfvec.page_info(p)
                else:
                    pi = {"w": p.rect.width, "h": p.rect.height}
                pages.append(pi)
            ocgs = sorted({v["name"] for v in (doc.get_ocgs() or {}).values()})
        kind = "vector" if any(not p.get("raster") for p in pages[:60]) else "raster"
        return {"ok": True, "kind": kind, "pdf": True, "pages": pages, "ocgs": ocgs, "oda": _oda()}
    from . import rastervec
    im = rastervec.open_image(path, 0, info_only=True)
    return {"ok": True, "kind": "raster", "pdf": False, "pages": im["pages"], "dpi": im["dpi"], "oda": _oda()}


def _oda():
    from .cadedit import find_oda
    return bool(find_oda())


def page_png(path: str, page: int, maxside: int = 1600) -> tuple[bytes, dict]:
    """Immagine di anteprima di una pagina (PDF) o dell'immagine, al massimo `maxside` pixel."""
    ext = _ext(path)
    if ext in PDF_EXT:
        import pymupdf
        with pymupdf.open(path) as doc:
            p = doc[page]
            z = maxside / max(p.rect.width, p.rect.height)
            pix = p.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False)
            return pix.tobytes("png"), {"w": p.rect.width, "h": p.rect.height, "px": pix.width}
    from . import rastervec
    im = rastervec.open_image(path, page)
    g = im["img"]
    z = min(1.0, maxside / max(g.size))
    if z < 1:
        g = g.resize((max(1, round(g.width * z)), max(1, round(g.height * z))))
    import io
    b = io.BytesIO()
    g.convert("RGB").save(b, "PNG")
    return b.getvalue(), {"w": im["img"].width, "h": im["img"].height, "px": g.width}


# ---------------------------------------------------------------- scala
def factor(opts: dict, unit_src_mm: float, page=None) -> float:
    """Unita' del disegno per unita' della sorgente.
    unit_src_mm = millimetri di carta per unita' della sorgente (punto PDF = 25,4/72; pixel = 25,4/dpi).
    opts.scale = N per 1:N; opts.ref_mm = distanza misurata sulla carta (mm) oppure opts.ref = [x1, y1, x2, y2] (unita' della sorgente),
    con opts.ref_len = misura reale (unita' del disegno)."""
    udiv = UNITS.get(opts.get("units", "mm"), UNITS["mm"])[0]
    if opts.get("ref_mm") and opts.get("ref_len"):  # dall'interfaccia: distanza misurata in mm della carta
        return float(opts["ref_len"]) * unit_src_mm / float(opts["ref_mm"])
    ref = opts.get("ref")
    if ref and opts.get("ref_len"):
        d = math.hypot(ref[2] - ref[0], ref[3] - ref[1])
        if d > 0:
            return float(opts["ref_len"]) / d
    n = float(opts.get("scale") or 1)
    return unit_src_mm * n / udiv


# ---------------------------------------------------------------- scrittura DXF
class Writer:
    def __init__(self, opts):
        import ezdxf
        self.ezdxf = ezdxf
        self.doc = ezdxf.new("R2018", setup=True)
        self.msp = self.doc.modelspace()
        u = UNITS.get(opts.get("units", "mm"), UNITS["mm"])
        self.doc.header["$INSUNITS"] = u[1]
        self.doc.header["$MEASUREMENT"] = 0 if opts.get("units") == "in" else 1
        self.doc.header["$LWDISPLAY"] = 1
        self.styles = {}
        self.ltypes = {}
        self.layers = {}
        self.stats = {}
        self.skipped = 0
        self.images = {}
        self.out = Path(opts["_out"]) if opts.get("_out") else None

    def _count(self, k, n=1):
        self.stats[k] = self.stats.get(k, 0) + n

    def add_layers(self, layers: dict):
        from ezdxf import colors
        for name, a in layers.items():
            if name in self.layers:
                continue
            self.layers[name] = a
            if name in self.doc.layers:
                continue
            lay = self.doc.layers.add(name)
            c = a.get("c")
            if c is not None:
                rgb = ((c >> 16) & 255, (c >> 8) & 255, c & 255)
                from .pdfvec import ACI_STD
                if rgb in ACI_STD:
                    lay.color = ACI_STD[rgb]
                else:
                    lay.rgb = rgb
            if a.get("lw") is not None and a["lw"] >= 0:
                lay.dxf.lineweight = a["lw"]
            if a.get("off"):
                lay.off()
            if a.get("plot") is False:
                lay.dxf.plot = 0
        _ = colors

    def _style(self, e):
        fam = e.get("font") or "Arial"
        key = (fam, bool(e.get("bold")), bool(e.get("italic")))
        if key in self.styles:
            return self.styles[key]
        name = fam + (" Bold" if key[1] else "") + (" Italic" if key[2] else "")
        name = "".join(ch if ch.isalnum() or ch in " -_" else "_" for ch in name)[:250] or "Standard"
        f = e.get("file")
        if name not in self.doc.styles:
            st = self.doc.styles.add(name, font=os.path.basename(f) if f else "arial.ttf")
            try:
                st.set_extended_font_data(fam, italic=key[2], bold=key[1])
            except Exception:  # noqa: BLE001
                pass
        self.styles[key] = name
        return name

    def _ltype(self, pat, k):
        key = tuple(round(v * k, 4) for v in pat)
        if key in self.ltypes:
            return self.ltypes[key]
        name = "MBV_" + hashlib.sha1(repr(key).encode()).hexdigest()[:8].upper()
        dxfpat = [sum(key)]
        for i, v in enumerate(key):
            dxfpat.append(v if i % 2 == 0 else -v)
        try:
            self.doc.linetypes.add(name, pattern=dxfpat, description="- - - " + " ".join("%g" % v for v in key))
        except Exception:  # noqa: BLE001
            name = "CONTINUOUS"
        self.ltypes[key] = name
        return name

    def _attrs(self, e, k):
        from .pdfvec import ACI_STD
        a = {"layer": e.get("L") or "0"}
        lay = self.layers.get(a["layer"], {})
        c = e.get("col")
        if c is not None and c != lay.get("c"):
            rgb = ((c >> 16) & 255, (c >> 8) & 255, c & 255)
            if rgb in ACI_STD:
                a["color"] = ACI_STD[rgb]
            else:
                a["true_color"] = self.ezdxf.colors.rgb2int(rgb)
        lw = e.get("lw")
        if lw is not None and lw != lay.get("lw") and e["t"] not in ("text", "mtext", "hatch"):
            a["lineweight"] = lw
        if e.get("lt"):
            a["linetype"] = self._ltype(e["lt"], k)
        return a

    def add(self, ents, k, ox, oy, space=None):
        """Entita' neutre -> DXF con x' = x*k + ox, y' = y*k + oy."""
        sp = space if space is not None else self.msp
        P = lambda x, y: (x * k + ox, y * k + oy)  # noqa: E731
        for e in ents:
            t = e["t"]
            try:
                a = self._attrs(e, k)
                if t == "line":
                    p = e["p"]
                    sp.add_line(P(p[0], p[1]), P(p[2], p[3]), dxfattribs=a)
                elif t == "arc":
                    sp.add_arc(P(*e["c"]), e["r"] * k, e["a"][0], e["a"][1], dxfattribs=a)
                elif t == "circle":
                    sp.add_circle(P(*e["c"]), e["r"] * k, dxfattribs=a)
                elif t == "poly":
                    pts = [(*P(v[0], v[1]), 0, 0, v[2]) for v in e["v"]]
                    sp.add_lwpolyline(pts, format="xyseb", close=bool(e.get("closed")), dxfattribs=a)
                elif t == "spline":
                    from ezdxf.math import Bezier4P, bezier_to_bspline
                    cp = [P(*q) for q in e["cp"]]
                    curves = [Bezier4P(cp[i:i + 4]) for i in range(0, len(cp) - 3, 3)]
                    sp.add_spline(dxfattribs=a).apply_construction_tool(bezier_to_bspline(curves))
                elif t == "hatch":
                    h = sp.add_hatch(dxfattribs={kk: vv for kk, vv in a.items() if kk != "linetype"})
                    h.set_solid_fill(color=a.get("color", 256), style=0, rgb=None)
                    if "true_color" in a:
                        h.dxf.true_color = a["true_color"]
                    for path in e["paths"]:
                        h.paths.add_polyline_path([(*P(v[0], v[1]), v[2]) for v in path], is_closed=True)
                    if e.get("alpha") is not None:
                        h.transparency = 1 - e["alpha"]
                elif t == "text":
                    st = self._style(e)
                    ta = {**a, "style": st, "height": max(e["h"] * k, 1e-6), "rotation": e.get("rot", 0)}
                    if e.get("wf") and abs(e["wf"] - 1) > 1e-3:
                        ta["width"] = e["wf"]
                    sp.add_text(e["s"], dxfattribs=ta).set_placement(P(*e["p"]))
                elif t == "mtext":
                    st = self._style(e)
                    h = max(e["h"] * k, 1e-6)
                    lsf = (e["spacing"] * k) / (h * 5 / 3) if e.get("spacing") else 1.0
                    txt = "\\P".join(s.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}") for s in e["lines"])
                    if e.get("wf") and abs(e["wf"] - 1) > 1e-3:
                        txt = "\\W%.3f;" % e["wf"] + txt
                    sp.add_mtext(txt, dxfattribs={**a, "style": st, "char_height": h, "insert": P(*e["p"]), "attachment_point": 1,
                                                  "rotation": e.get("rot", 0), "line_spacing_factor": max(0.25, min(4.0, lsf))})
                elif t == "image":
                    self._image(sp, e, P, k, a)
                else:
                    continue
                self._count(t)
            except Exception:  # noqa: BLE001
                self.skipped += 1

    def _image(self, sp, e, P, k, a):
        """IMAGE con il file accanto al disegno (cartella "<nome>_immagini", percorso relativo come fa AutoCAD)."""
        if not self.out:
            return
        folder = self.out.parent / (self.out.stem + "_" + tr("srv_drawing.cartella_immagini"))
        folder.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha1(e["data"]).hexdigest()[:12]
        name = f"{self.out.stem}_{h}.{e['ext']}"
        f = folder / name
        if not f.exists():
            f.write_bytes(e["data"])
        rel = folder.name + "\\" + name
        idef = self.images.get(rel)
        if idef is None:
            idef = self.images[rel] = self.doc.add_image_def(filename=rel, size_in_pixel=(e["w"], e["h"]))
        o, u, v = e["o"], e["u"], e["v"]
        # DXF: punto di inserimento = angolo in basso a sinistra (pixel dell'ultima riga), v verso l'alto
        bl = P(o[0] + v[0], o[1] + v[1])
        up = (-v[0] * k / e["h"], -v[1] * k / e["h"], 0)
        ux = (u[0] * k / e["w"], u[1] * k / e["w"], 0)
        img = sp.add_image(idef, insert=bl, size_in_units=(1, 1), rotation=0, dxfattribs={kk: vv for kk, vv in a.items() if kk == "layer"})
        img.dxf.u_pixel = ux
        img.dxf.v_pixel = up
        img.dxf.image_size = (e["w"], e["h"])
        if e["ext"] == "png":
            img.dxf.flags = img.dxf.flags | img.USE_TRANSPARENCY  # trasparenza del PNG (maschere morbide del PDF)
        img.reset_boundary_path()

    def frame(self, x0, y0, x1, y1, name):
        lay = tr("srv_drawing.layer_contorno_pagina")
        if lay not in self.doc.layers:
            l = self.doc.layers.add(lay, color=8)
            l.dxf.plot = 0
        self.msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": lay})
        self.msp.add_text(name, dxfattribs={"layer": lay, "height": (y1 - y0) * 0.012}).set_placement((x0, y1 + (y1 - y0) * 0.006))

    def sheet(self, name, w_mm, h_mm, cx, cy, view_h, x0, y0, x1, y1):
        """Layout con la carta della pagina e una finestra sul pezzo di modello (scala = h_carta / view_h)."""
        base, i = name[:240], 2
        while base in self.doc.layouts:
            base = f"{name[:236]} ({i})"
            i += 1
        lay = self.doc.layouts.new(base)
        lay.page_setup(size=(w_mm, h_mm), margins=(0, 0, 0, 0), units="mm")
        lay.add_viewport(center=(w_mm / 2, h_mm / 2), size=(w_mm, h_mm), view_center_point=(cx, cy), view_height=view_h)
        return lay

    def save(self, out: str):
        ext = _ext(out)
        if ext == "dwg":
            from .cadedit import _to_dwg
            _to_dwg(self.doc, out)
        else:
            self.doc.saveas(out)


# ---------------------------------------------------------------- conversione
def _pages(sel, n):
    if sel in (None, "", "all"):
        return list(range(n))
    if isinstance(sel, list):
        return [p for p in sel if 0 <= p < n]
    out = []
    for part in str(sel).replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            a = int(a or 1)
            b = int(b or n)
            out += list(range(a - 1, min(b, n)))
        else:
            out.append(int(part) - 1)
    return [p for p in dict.fromkeys(out) if 0 <= p < n]


def extract_page(path: str, page: int, opts: dict, update=None) -> dict:
    """Entita' di una pagina (o dell'immagine) + layer + metodo usato + misure della sorgente."""
    ext = _ext(path)
    method = opts.get("method", "auto")
    if ext in PDF_EXT:
        import pymupdf
        from . import pdfvec
        with pymupdf.open(path) as doc:
            p = doc[page]
            pi = pdfvec.page_info(p)
            raster = method == "raster" or (method == "auto" and pi["raster"])
            if not raster:
                layers = {}
                ents = pdfvec.extract(p, opts, layers)
                return {"ents": ents, "layers": layers, "method": "vector", "w": p.rect.width, "h": p.rect.height, "unit_mm": 25.4 / 72,
                        "images": len(p.get_images())}
            dpi = int(opts.get("dpi") or 300)
            z = dpi / 72
            pix = p.get_pixmap(matrix=pymupdf.Matrix(z, z), colorspace=pymupdf.csGRAY, alpha=False)
            from PIL import Image
            img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
            pw, ph = p.rect.width, p.rect.height
        from . import rastervec
        r = rastervec.vectorize(img, {**opts, "_dpi": dpi}, update=update)
        # le entita' della scansione restano in pixel: unita' della sorgente = 25,4/dpi mm
        return {**r, "method": "raster", "w": r["size"][0], "h": r["size"][1], "unit_mm": 25.4 / dpi, "page_pt": [pw, ph]}
    from . import rastervec
    im = rastervec.open_image(path, page)
    dpi = float(opts.get("img_dpi") or im["dpi"] or 300)  # risoluzione del file (o quella indicata a mano)
    r = rastervec.vectorize(im["img"], {**opts, "_dpi": dpi}, update=update)
    return {**r, "method": "raster", "w": r["size"][0], "h": r["size"][1], "unit_mm": 25.4 / dpi, "dpi": dpi}


def convert(src: str, out: str, opts: dict | None = None, update=None) -> dict:
    opts = dict(opts or {})
    update = update or (lambda **k: None)
    ext = _ext(src)
    if ext in PDF_EXT:
        import pymupdf
        with pymupdf.open(src) as d:
            if d.needs_pass:
                raise RuntimeError(tr("srv_drawing.pdf_protetto"))
            n = len(d)
            labels = [(d[i].get_label() or str(i + 1)) for i in range(n)]
    else:
        from . import rastervec
        n = rastervec.open_image(src, 0, info_only=True)["pages"].__len__()
        labels = [str(i + 1) for i in range(n)]
    pages = _pages(opts.get("pages"), n)
    if not pages:
        raise ValueError(tr("srv_drawing.nessuna_pagina"))
    W = Writer({**opts, "_out": out})
    sheets = opts.get("layout", "model") == "sheets"
    x = 0.0
    methods, images = set(), 0
    approx = False
    for i, pg in enumerate(pages):
        def sub(progress=None, message=None, _i=i):
            update(progress=(_i + (progress or 0)) / len(pages) * 0.92, message=message)
        update(progress=i / len(pages) * 0.92, message=tr("srv_drawing.pagina_0_1", i + 1, len(pages)))
        r = extract_page(src, pg, opts, update=sub)
        methods.add(r["method"])
        images += r.get("images", 0)
        approx = approx or r["method"] == "raster"
        k = factor(opts, r["unit_mm"], pg)
        W.add_layers(r["layers"])
        w, h = r["w"] * k, r["h"] * k
        W.add(r["ents"], k, x, 0.0)
        name = tr("srv_drawing.pagina_0", labels[pg]) if len(pages) > 1 or sheets else ""
        if len(pages) > 1:
            W.frame(x, 0, x + w, h, name)
        if sheets:
            paper_mm = r["unit_mm"]
            W.sheet(name, r["w"] * paper_mm, r["h"] * paper_mm, x + w / 2, h / 2, h, x, 0, x + w, h)
        x += w + max(w, h) * 0.08
    update(progress=0.95, message=tr("srv_drawing.scrittura_0", _ext(out).upper()))
    W.save(out)
    return {"ok": True, "path": out, "stats": W.stats, "skipped": W.skipped, "pages": len(pages), "methods": sorted(methods),
            "approx": approx, "images": images}


# ---------------------------------------------------------------- anteprima
def preview(src: str, page: int, opts: dict, update=None) -> dict:
    """Entita' di una pagina per l'anteprima sovrapposta (coordinate della sorgente, y verso l'alto) + immagine pulita (scansioni)."""
    update = update or (lambda **k: None)
    r = extract_page(src, page, opts, update=update)
    res = {"ok": True, "method": r["method"], "w": r["w"], "h": r["h"], "unit_mm": r["unit_mm"], "counts": {}}
    for e in r["ents"]:
        res["counts"][e["t"]] = res["counts"].get(e["t"], 0) + 1
    ents = r["ents"]
    if len(ents) > 150000:
        ents = ents[:150000]
        res["truncated"] = True
    res["ents"] = [{k: v for k, v in e.items() if k not in ("file", "data")} for e in ents]
    res["layers"] = r["layers"]
    if r.get("clean") is not None:
        PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
        f = PREVIEW_DIR / (hashlib.sha1(f"{src}|{page}|{json.dumps(opts, sort_keys=True)}".encode()).hexdigest()[:16] + ".png")
        im = r["clean"]
        z = min(1.0, 2400 / max(im.size))
        if z < 1:
            im = im.resize((max(1, round(im.width * z)), max(1, round(im.height * z))))
        im.save(f, "PNG")
        res["clean"] = str(f)
    res["skew"] = r.get("skew")
    res["k"] = factor(opts, r["unit_mm"], page)
    return res
