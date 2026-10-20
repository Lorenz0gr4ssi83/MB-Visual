"""Strumenti PDF: unisci, estrai/elimina/ruota pagine, dividi, filigrana e timbro di testo."""
import io
import math
from pathlib import Path

from pypdf import PdfReader, PdfWriter, Transformation


def parse_pages(spec: str, n: int) -> list[int]:
    """'1-3, 5, 8-' -> indici 0-based validi."""
    out = []
    for part in (spec or "").replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            a = int(a) if a.strip() else 1
            b = int(b) if b.strip() else n
            out.extend(range(a, b + 1))
        else:
            out.append(int(part))
    pages = [p - 1 for p in out if 1 <= p <= n]
    if not pages:
        raise ValueError(f"Nessuna pagina valida (il documento ha {n} pagine)")
    return pages


def merge(paths: list[str], out: str) -> dict:
    w = PdfWriter()
    for p in paths:
        w.append(p)
    w.write(out)
    return {"ok": True, "path": out, "pagine": len(w.pages)}


def extract(path: str, pages: str, out: str) -> dict:
    r = PdfReader(path)
    w = PdfWriter()
    for i in parse_pages(pages, len(r.pages)):
        w.add_page(r.pages[i])
    w.write(out)
    return {"ok": True, "path": out, "pagine": len(w.pages)}


def delete(path: str, pages: str, out: str) -> dict:
    r = PdfReader(path)
    drop = set(parse_pages(pages, len(r.pages)))
    w = PdfWriter()
    for i, pg in enumerate(r.pages):
        if i not in drop:
            w.add_page(pg)
    if not len(w.pages):
        raise ValueError("Non si possono eliminare tutte le pagine")
    w.write(out)
    return {"ok": True, "path": out, "pagine": len(w.pages)}


def rotate(path: str, pages: str, angle: int, out: str) -> dict:
    r = PdfReader(path)
    sel = set(parse_pages(pages or f"1-{len(r.pages)}", len(r.pages)))
    w = PdfWriter()
    for i, pg in enumerate(r.pages):
        if i in sel:
            pg.rotate(int(angle))
        w.add_page(pg)
    w.write(out)
    return {"ok": True, "path": out, "pagine": len(w.pages)}


def split(path: str, folder: str) -> dict:
    r = PdfReader(path)
    stem = Path(path).stem
    outs = []
    for i, pg in enumerate(r.pages, 1):
        w = PdfWriter()
        w.add_page(pg)
        o = Path(folder) / f"{stem}_pag{i:03d}.pdf"
        w.write(o)
        outs.append(str(o))
    return {"ok": True, "files": outs}


def _escape(t: str) -> str:
    return t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _text_overlay(w: float, h: float, text: str, mode: str, size: float, opacity: float, color=(0.55, 0.1, 0.1)) -> bytes:
    """PDF di una pagina con il solo testo (Helvetica), diagonale (filigrana) o in alto a destra (timbro)."""
    txt = text.encode("cp1252", "replace").decode("cp1252")
    r, g, b = color
    if mode == "filigrana":
        ang = math.atan2(h, w)
        c, s = math.cos(ang), math.sin(ang)
        tw = 0.5 * size * len(txt)
        x = w / 2 - c * tw / 2
        y = h / 2 - s * tw / 2
        body = f"q /GS1 gs {r} {g} {b} rg BT /F1 {size} Tf {c:.4f} {s:.4f} {-s:.4f} {c:.4f} {x:.2f} {y:.2f} Tm ({_escape(txt)}) Tj ET Q"
    else:
        lines = txt.split("\n")
        bw = max(len(l) for l in lines) * size * 0.55 + 16
        bh = len(lines) * size * 1.3 + 10
        x0, y0 = w - bw - 24, h - bh - 24
        parts = [f"q /GS1 gs 1 1 1 rg {x0:.2f} {y0:.2f} {bw:.2f} {bh:.2f} re f {r} {g} {b} RG 1.5 w {x0:.2f} {y0:.2f} {bw:.2f} {bh:.2f} re S {r} {g} {b} rg BT /F1 {size} Tf"]
        for k, l in enumerate(lines):
            parts.append(f"1 0 0 1 {x0 + 8:.2f} {y0 + bh - 6 - size * (k + 1) * 1.15:.2f} Tm ({_escape(l)}) Tj")
        parts.append("ET Q")
        body = " ".join(parts)
    content = body.encode("cp1252", "replace")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w:.2f} {h:.2f}] /Resources << /Font << /F1 4 0 R >> /ExtGState << /GS1 5 0 R >> >> /Contents 6 0 R >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        f"<< /Type /ExtGState /ca {opacity:.2f} /CA {opacity:.2f} >>".encode(),
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
    ]
    buf = io.BytesIO()
    buf.write(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(buf.tell())
        buf.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
    xref = buf.tell()
    buf.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for o in offs:
        buf.write(f"{o:010d} 00000 n \n".encode())
    buf.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return buf.getvalue()


def stamp(path: str, text: str, mode: str, out: str, pages: str = "", opacity: float = 0.25) -> dict:
    r = PdfReader(path)
    sel = set(parse_pages(pages or f"1-{len(r.pages)}", len(r.pages)))
    w = PdfWriter()
    for i, pg in enumerate(r.pages):
        if i in sel:
            box = pg.mediabox
            pw, ph = float(box.width), float(box.height)
            rot = (pg.get("/Rotate") or 0) % 360
            vw, vh = (ph, pw) if rot in (90, 270) else (pw, ph)
            size = (min(vw, vh) / 9 if mode == "filigrana" else 13)
            ov = PdfReader(io.BytesIO(_text_overlay(vw, vh, text, mode, size, opacity if mode == "filigrana" else 0.95))).pages[0]
            if rot:
                # la sovrapposizione e' disegnata nel verso di lettura: la riportiamo nel sistema della pagina
                pg.merge_transformed_page(ov, Transformation().rotate(rot).translate(*({90: (pw, 0), 180: (pw, ph), 270: (0, ph)}[rot])))
            else:
                pg.merge_page(ov)
        w.add_page(pg)
    w.write(out)
    return {"ok": True, "path": out, "pagine": len(w.pages)}
