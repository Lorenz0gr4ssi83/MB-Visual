"""Editor PDF (PyMuPDF): lettura dei testi con posizione e stile, sostituzione del testo esistente, oscuramento,
compressione, password, numeri di pagina, conversione in Word.

Le coordinate scambiate con l'interfaccia sono nello spazio PDF (origine in basso a sinistra, punti tipografici),
lo stesso usato da pdf.js: cosi' le caselle si posizionano sulla pagina anche se ruotata.
"""
import os
import re
import shutil
from pathlib import Path

import pymupdf

FONTS_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
# famiglia del font originale -> file di Windows (normale, grassetto, corsivo, grassetto corsivo)
FAMILIES = [
    (r"calibri", ("calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf")),
    (r"cambria", ("cambria.ttc", "cambriab.ttf", "cambriai.ttf", "cambriaz.ttf")),
    (r"arialn|arial.?narrow", ("ARIALN.TTF", "ARIALNB.TTF", "ARIALNI.TTF", "ARIALNBI.TTF")),
    (r"verdana", ("verdana.ttf", "verdanab.ttf", "verdanai.ttf", "verdanaz.ttf")),
    (r"tahoma", ("tahoma.ttf", "tahomabd.ttf", "tahoma.ttf", "tahomabd.ttf")),
    (r"georgia", ("georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf")),
    (r"segoe", ("segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf")),
    (r"cour|mono|consol", ("cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf")),
    (r"times|serif|roman|garamond|book", ("times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf")),
    (r"", ("arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf")),  # predefinito (Helvetica, Arial, sans)
]


# fuori da Windows: famiglia del font originale -> famiglie da cercare tra i caratteri installati (mbvisual/fonts.py)
OTHER_FAMILIES = [
    (r"calibri", ("calibri", "carlito", "helvetica neue", "arial")),
    (r"cambria", ("cambria", "caladea", "georgia", "times new roman")),
    (r"arialn|arial.?narrow", ("arial narrow", "liberation sans narrow", "helvetica neue", "arial")),
    (r"verdana", ("verdana", "dejavu sans")),
    (r"tahoma", ("tahoma", "verdana", "dejavu sans")),
    (r"georgia", ("georgia", "dejavu serif")),
    (r"segoe", ("segoe ui", "helvetica neue", "arial")),
    (r"cour|mono|consol", ("courier new", "liberation mono", "dejavu sans mono", "menlo")),
    (r"times|serif|roman|garamond|book", ("times new roman", "liberation serif", "times", "dejavu serif")),
    (r"", ("arial", "liberation sans", "helvetica", "dejavu sans")),
]


def _font_file(name: str, bold: bool, italic: bool) -> Path | None:
    n = (name or "").lower().split("+")[-1]
    from .paths import IS_WIN
    if not IS_WIN:
        from . import fonts
        for pat, fams in OTHER_FAMILIES:
            if re.search(pat, n):
                for fam in fams:
                    f = fonts.find(fam, bold, italic)
                    if f:
                        return Path(f)
        return None
    for pat, files in FAMILIES:
        if re.search(pat, n):
            f = FONTS_DIR / files[(2 if italic else 0) + (1 if bold else 0)]
            if f.exists():
                return f
    return None


def _to_pdf(page, rect) -> list:
    """Rettangolo MuPDF (origine in alto a sinistra) -> spazio PDF [x0, y0, x1, y1]."""
    r = pymupdf.Rect(rect) * ~page.transformation_matrix
    r.normalize()
    return [round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)]


def _from_pdf(page, box) -> pymupdf.Rect:
    r = pymupdf.Rect(box) * page.transformation_matrix
    r.normalize()
    return r


def _color(c: int) -> str:
    return f"#{c:06x}"


def text_lines(path: str, pno: int) -> dict:
    """Righe di testo di una pagina, con il rettangolo, il testo e lo stile della prima porzione."""
    with pymupdf.open(path) as doc:
        page = doc[pno]
        out = []
        for b in page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE)["blocks"]:
            for ln in b.get("lines", []):
                spans = [s for s in ln["spans"] if s["text"].strip()]
                if not spans:
                    continue
                s0 = spans[0]
                text = "".join(s["text"] for s in ln["spans"]).rstrip()
                bbox = pymupdf.Rect(ln["bbox"])
                o = pymupdf.Point(s0["origin"]) * ~page.transformation_matrix  # linea di base, nello spazio PDF
                out.append({
                    "box": _to_pdf(page, bbox), "origin": [round(o.x, 2), round(o.y, 2)], "text": text, "font": s0["font"], "size": round(s0["size"], 2),
                    "color": _color(s0["color"]), "bold": bool(s0["flags"] & 16) or "bold" in s0["font"].lower(),
                    "italic": bool(s0["flags"] & 2) or "italic" in s0["font"].lower() or "oblique" in s0["font"].lower(),
                    "dir": [round(v, 3) for v in ln.get("dir", (1, 0))],
                })
        return {"ok": True, "righe": out, "pagine": len(doc)}


_FONT_CACHE: dict = {}


def _font(name: str, bold: bool, italic: bool) -> pymupdf.Font:
    ff = _font_file(name, bold, italic)
    key = str(ff) if ff else ("helv", bold, italic)
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = pymupdf.Font(fontfile=str(ff)) if ff else pymupdf.Font("hebo" if bold else "helv")
    return _FONT_CACHE[key]


def _insert_text(page, rect: pymupdf.Rect, text: str, font: str, size: float, color: str, bold: bool, italic: bool,
                 align: int = 0, origin=None):
    """Scrive il testo una riga sotto l'altra a partire dalla linea di base originale, senza andare a capo da solo
    (come un editor PDF: la riga si allunga). Il font e' incorporato con la tabella Unicode (accenti, €, simboli)."""
    c = (color or "#000000").lstrip("#").ljust(6, "0")
    rgb = tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = _font(font, bold, italic)
    tw = pymupdf.TextWriter(page.rect, color=rgb)
    x0, base = (origin.x, origin.y) if origin is not None else (rect.x0, rect.y0 + size * f.ascender)
    for i, line in enumerate(text.split("\n")):
        w = f.text_length(line, fontsize=size)
        x = x0 if align == 0 else (rect.x1 - w if align == 2 else rect.x0 + (rect.width - w) / 2)
        tw.append((x, base + i * size * 1.2), line, font=f, fontsize=size)
    tw.write_text(page)


def apply_edits(path: str, edits: list[dict]) -> dict:
    """Modifiche applicate al file (copia di lavoro): replace (testo esistente), add (testo nuovo), redact (oscura), whiteout."""
    tmp = path + ".mbv-edit.pdf"
    with pymupdf.open(path) as doc:
        by_page: dict[int, list] = {}
        for e in edits:
            by_page.setdefault(int(e["page"]), []).append(e)
        for pno, items in by_page.items():
            page = doc[pno]
            # 1) togliere il testo da sostituire / oscurare
            todo = []
            for e in items:
                r = _from_pdf(page, e["box"])
                if e["kind"] == "replace":
                    page.add_redact_annot(r + (-0.5, -0.5, 0.5, 0.5))
                    todo.append((e, r))
                elif e["kind"] == "redact":
                    page.add_redact_annot(r, fill=(0, 0, 0))
                elif e["kind"] == "whiteout":
                    page.add_redact_annot(r, fill=(1, 1, 1))
                elif e["kind"] == "add":
                    todo.append((e, r))
            has_redact = any(e["kind"] in ("redact", "whiteout") for e in items)
            if any(e["kind"] != "add" for e in items):
                # sostituzione: si toglie solo il testo, grafica e immagini restano; l'oscuramento elimina anche le immagini sotto
                page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS if has_redact else pymupdf.PDF_REDACT_IMAGE_NONE,
                                      graphics=pymupdf.PDF_REDACT_LINE_ART_NONE if not has_redact else pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED)
            # 2) scrivere il testo nuovo con lo stile dell'originale
            for e, r in todo:
                if e.get("text", "").strip():
                    origin = pymupdf.Point(e["origin"]) * page.transformation_matrix if e.get("origin") else None
                    _insert_text(page, r, e["text"], e.get("font", ""), float(e.get("size", 11)), e.get("color", "#000000"),
                                 bool(e.get("bold")), bool(e.get("italic")), int(e.get("align", 0)), origin)
        try:
            doc.subset_fonts()  # dei font aggiunti restano solo i caratteri usati (il file non si appesantisce)
        except Exception:  # noqa: BLE001
            pass
        doc.save(tmp, garbage=3, deflate=True)
    os.replace(tmp, path)
    return {"ok": True}


def compress(path: str, out: str, dpi: int = 150, quality: int = 75) -> dict:
    before = os.path.getsize(path)
    with pymupdf.open(path) as doc:
        try:
            doc.rewrite_images(dpi_threshold=dpi + 30, dpi_target=dpi, quality=quality, lossy=True, lossless=True, bitonal=True, color=True, gray=True)
        except Exception:  # noqa: BLE001 - versioni senza ricompressione delle immagini
            pass
        doc.subset_fonts()
        doc.save(out, garbage=4, deflate=True, clean=True, deflate_images=True, deflate_fonts=True, use_objstms=1)
    after = os.path.getsize(out)
    return {"ok": True, "path": out, "prima": before, "dopo": after}


def protect(path: str, out: str, password: str, owner: str = "", allow_print: bool = True, allow_copy: bool = False, allow_edit: bool = False) -> dict:
    perm = pymupdf.PDF_PERM_ACCESSIBILITY
    if allow_print:
        perm |= pymupdf.PDF_PERM_PRINT | pymupdf.PDF_PERM_PRINT_HQ
    if allow_copy:
        perm |= pymupdf.PDF_PERM_COPY
    if allow_edit:
        perm |= pymupdf.PDF_PERM_MODIFY | pymupdf.PDF_PERM_ANNOTATE | pymupdf.PDF_PERM_FORM
    with pymupdf.open(path) as doc:
        doc.save(out, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw=password, owner_pw=owner or password + "#mbv", permissions=perm, garbage=3, deflate=True)
    return {"ok": True, "path": out}


def unlock(path: str, out: str, password: str) -> dict:
    with pymupdf.open(path) as doc:
        if doc.needs_pass and not doc.authenticate(password):
            raise ValueError("Password errata")
        doc.save(out, encryption=pymupdf.PDF_ENCRYPT_NONE, garbage=3, deflate=True)
    return {"ok": True, "path": out}


def page_numbers(path: str, out: str, fmt: str = "Pagina {n} di {tot}", pos: str = "basso-destra", start: int = 1, size: float = 9) -> dict:
    with pymupdf.open(path) as doc:
        tot = len(doc)
        for i, page in enumerate(doc):
            text = fmt.replace("{n}", str(i + start)).replace("{tot}", str(tot + start - 1))
            r = page.rect
            w = pymupdf.get_text_length(text, fontname="helv", fontsize=size)
            x = {"sinistra": 36, "centro": (r.width - w) / 2, "destra": r.width - 36 - w}[pos.split("-")[1]]
            y = 28 + size if pos.startswith("alto") else r.height - 24
            p = pymupdf.Point(x, y) * page.derotation_matrix
            page.insert_text(p, text, fontname="helv", fontsize=size, color=(0.2, 0.2, 0.2), rotate=page.rotation)
        doc.save(out, garbage=3, deflate=True)
    return {"ok": True, "path": out, "pagine": tot}


def to_word(path: str, out: str) -> dict:
    from pdf2docx import Converter
    cv = Converter(path)
    try:
        cv.convert(out)
    finally:
        cv.close()
    return {"ok": True, "path": out}


def to_images(path: str, folder: str, dpi: int = 150, fmt: str = "png") -> dict:
    outs = []
    with pymupdf.open(path) as doc:
        for i, page in enumerate(doc, 1):
            o = Path(folder) / f"{Path(path).stem}_pag{i:03d}.{fmt}"
            page.get_pixmap(dpi=dpi).save(str(o))
            outs.append(str(o))
    return {"ok": True, "files": outs}


def insert_blank(path: str, out: str, after: int) -> dict:
    with pymupdf.open(path) as doc:
        ref = doc[min(max(after - 1, 0), len(doc) - 1)].rect
        doc.new_page(pno=after, width=ref.width, height=ref.height)
        doc.save(out, garbage=3, deflate=True)
        return {"ok": True, "path": out, "pagine": len(doc)}


def reorder(path: str, out: str, order: list[int]) -> dict:
    with pymupdf.open(path) as doc:
        doc.select([int(i) for i in order])
        doc.save(out, garbage=3, deflate=True)
        return {"ok": True, "path": out, "pagine": len(doc)}


def working_copy(path: str, folder: Path) -> str:
    folder.mkdir(parents=True, exist_ok=True)
    # nome: originale + codice casuale (senza accumulare i codici delle copie precedenti)
    stem = re.sub(r"(_[0-9a-f]{8})+$", "", Path(path).stem)
    dst = folder / (stem + "_" + os.urandom(4).hex() + ".pdf")
    shutil.copyfile(path, dst)
    return str(dst)


# ---------------------------------------------------------------- OCR con il motore integrato del sistema (Windows o macOS)
def _ocr_cmd(img: str) -> list:
    """Comando OCR del sistema: ocr.ps1 (motore di Windows, PowerShell) oppure, sul Mac, mbvocr (framework Vision,
    tools/mbvocr/mbvocr.swift compilato da tools/build_mac.py). Stessa uscita JSON per entrambi."""
    from .paths import BIN_DIR, IS_MAC, IS_WIN
    if IS_WIN:
        script = Path(__file__).with_name("ocr.ps1")
        return ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), img, "it"]
    if IS_MAC:
        exe = next((p for p in (BIN_DIR / "mbvocr", Path.home() / ".mbvisual" / "mbvocr" / "mbvocr") if p.is_file()), None)
        if exe:
            return [str(exe), img, "it-IT"]
    raise RuntimeError("Riconoscimento del testo non disponibile su questo sistema")


def _ocr_png(png: bytes):
    """Parole riconosciute in un'immagine: [[(testo, x, y, larghezza, altezza), ...] per riga]. Usa il motore OCR del
    sistema in un processo separato (vedi _ocr_cmd): nessuna libreria aggiuntiva nell'app."""
    import json
    import subprocess
    import tempfile
    from .paths import NO_WINDOW
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        f.write(png)
        img = f.name
    try:
        r = subprocess.run(_ocr_cmd(img), capture_output=True, timeout=300, creationflags=NO_WINDOW)
        if r.returncode != 0:
            raise RuntimeError("Riconoscimento del testo non riuscito: " + r.stderr.decode("utf-8", "replace").strip()[-300:])
        out = r.stdout.decode("utf-8-sig", "replace").strip()
        data = json.loads(out) if out else []
        if data and isinstance(data[0], list) and data[0] and not isinstance(data[0][0], list):
            data = [data] if isinstance(data[0][0], str) else data
        return [[tuple(w) for w in line] for line in data]
    finally:
        os.remove(img)


def ocr(path: str, out: str, dpi: int = 300, update=None) -> dict:
    """Rende ricercabile un PDF scansionato: sotto ogni pagina senza testo si inserisce il testo riconosciuto, invisibile
    e allineato alle parole (si cerca, si seleziona e si copia come in un PDF nato digitale)."""
    words = pages = 0
    with pymupdf.open(path) as doc:
        n = len(doc)
        for i, page in enumerate(doc):
            if update:
                update(progress=i / max(n, 1), message=f"Riconoscimento del testo: pagina {i + 1} di {n}")
            if len(page.get_text().strip()) > 40:
                continue  # la pagina ha gia' del testo
            pix = page.get_pixmap(dpi=dpi)
            lines = _ocr_png(pix.tobytes("png"))
            s = 72 / dpi
            for line in lines:
                for text, x, y, w, h in line:
                    if not text.strip():
                        continue
                    fs = max(2.0, h * s * 0.92)
                    width = pymupdf.get_text_length(text, fontname="helv", fontsize=fs) or 1
                    p = pymupdf.Point(x * s, (y + h) * s - h * s * 0.18) * page.derotation_matrix
                    sx = (w * s) / width
                    page.insert_text(p, text, fontname="helv", fontsize=fs, render_mode=3, rotate=page.rotation,
                                     morph=(p, pymupdf.Matrix(sx, 1)) if page.rotation == 0 else None)
                    words += 1
            pages += 1
        doc.save(out, garbage=3, deflate=True)
    return {"ok": True, "path": out, "pagine": pages, "parole": words}
