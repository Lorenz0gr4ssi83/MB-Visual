"""PDF vettoriale -> entita' di disegno (linee, archi, cerchi, polilinee, spline, retini, testi).

Le tavole esportate da AutoCAD/Revit scrivono archi e cerchi come curve di Bezier (in genere 4 per un cerchio): qui si
riconoscono le Bezier che sono archi veri (cerchio per i due estremi e il punto medio, controllo a t=0,25/0,75 e delle
tangenti) e si uniscono gli archi consecutivi con lo stesso centro; quelle che non lo sono restano spline. Le polilinee
con molti segmenti corti e uguali (archi "spezzati" dal driver di stampa) si possono riportare ad archi (opzione).

Uscita: entita' neutre in punti PDF con y verso l'alto (vedi todrawing.py per il formato e la scrittura in DXF).
Testi da page.get_texttrace(): posizione, altezza (altezza delle maiuscole dal carattere), rotazione, carattere, colore,
layer OCG. I testi invisibili (render mode 3, es. l'OCR o i testi SHX di AutoCAD resi a tratti) vanno su un layer spento.
"""
import math
import re
from functools import lru_cache

import pymupdf

from .i18n import t as tr

ACI_STD = {(255, 0, 0): 1, (255, 255, 0): 2, (0, 255, 0): 3, (0, 255, 255): 4, (0, 0, 255): 5, (255, 0, 255): 6, (0, 0, 0): 7, (255, 255, 255): 7}
SCALE_RE = re.compile(r"(?:SCALA|SCALE|ECHELLE|ÉCHELLE|ESCALA|MAßSTAB|MASSSTAB|SC\.)\s*:?\s*1\s*[:/]\s*(\d{1,5})", re.I)
RATIO_RE = re.compile(r"(?<![\d.,])1\s*:\s*(\d{1,5})(?![\d.,])")


# ---------------------------------------------------------------- geometria di base
def _bez(p0, p1, p2, p3, t):
    u = 1 - t
    a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
    return (a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1])


def _circ3(a, b, c):
    ax, ay = a
    bx, by = b
    cx, cy = c
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return None
    a2, b2, c2 = ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy
    ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
    uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
    return ux, uy


def _d(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _ang(c, p):
    return math.degrees(math.atan2(p[1] - c[1], p[0] - c[0])) % 360


def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _line_dist(p, a, b):
    L = _d(a, b)
    if L < 1e-12:
        return _d(p, a)
    return abs(_cross(a, b, p)) / L


def bez_kind(p0, p1, p2, p3, tol):
    """("L",) se la Bezier e' un segmento, ("A", centro, raggio, ccw, ampiezza) se e' un arco di cerchio, altrimenti None."""
    if _line_dist(p1, p0, p3) <= tol and _line_dist(p2, p0, p3) <= tol and _d(p0, p3) > 1e-9:
        return ("L",)
    m = _bez(p0, p1, p2, p3, 0.5)
    c = _circ3(p0, m, p3)
    if c is None:
        return None
    r = _d(c, p0)
    if r > 1e6 or r < 1e-6:
        return None
    t2 = max(tol, r * 2e-3)
    for t in (0.125, 0.25, 0.375, 0.625, 0.75, 0.875):
        if abs(_d(_bez(p0, p1, p2, p3, t), c) - r) > t2:
            return None
    # tangenti negli estremi perpendicolari al raggio (esclude le curve a S che passano per gli stessi tre punti)
    for a, b in ((p0, p1), (p3, p2)):
        L = _d(a, b)
        if L > 1e-9:
            cos = ((b[0] - a[0]) * (a[0] - c[0]) + (b[1] - a[1]) * (a[1] - c[1])) / (L * r)
            if abs(cos) > 0.03:
                return None
    ccw = _cross(c, p0, m) > 0
    a0, am, a1 = _ang(c, p0), _ang(c, m), _ang(c, p3)
    sw = ((a1 - a0) % 360) if ccw else ((a0 - a1) % 360)
    if _d(p0, p3) < 1e-9:
        sw = 360.0
    return ("A", c, r, ccw, sw)


def fit_circle(pts):
    """Cerchio ai minimi quadrati (Kasa). -> (cx, cy, r, scarto massimo) o None."""
    import numpy as np
    P = np.asarray(pts, dtype=float)
    if len(P) < 3:
        return None
    mx, my = P[:, 0].mean(), P[:, 1].mean()
    x, y = P[:, 0] - mx, P[:, 1] - my
    A = np.column_stack([x, y, np.ones_like(x)])
    b = x * x + y * y
    try:
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    except Exception:  # noqa: BLE001
        return None
    cx, cy = sol[0] / 2, sol[1] / 2
    r2 = sol[2] + cx * cx + cy * cy
    if r2 <= 0:
        return None
    r = math.sqrt(r2)
    res = np.abs(np.hypot(x - cx, y - cy) - r).max()
    return cx + mx, cy + my, r, float(res)


def bulge_of(c, p0, p1, ccw, sw=None):
    if sw is None:
        a0, a1 = _ang(c, p0), _ang(c, p1)
        sw = ((a1 - a0) % 360) if ccw else ((a0 - a1) % 360)
    b = math.tan(math.radians(sw) / 4)
    return b if ccw else -b


# ---------------------------------------------------------------- tracciati -> segmenti
def _subpaths(items, H, tol):
    """Elementi di get_drawings -> sottotracciati: liste di segmenti ("L", p0, p1) / ("A", p0, p1, c, r, ccw, sw) / ("B", p0, c1, c2, p1)
    in coordinate con y verso l'alto."""
    def P(p):
        return (float(p.x), H - float(p.y))
    subs, cur, last = [], [], None
    for it in items:
        k = it[0]
        if k == "re":
            if cur:
                subs.append(cur)
                cur, last = [], None
            r = it[1]
            q = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
            q = [(float(x), H - float(y)) for x, y in q]
            subs.append([("L", q[i], q[(i + 1) % 4]) for i in range(4)])
            continue
        if k == "qu":
            if cur:
                subs.append(cur)
                cur, last = [], None
            qd = it[1]
            q = [P(qd.ul), P(qd.ur), P(qd.lr), P(qd.ll)]
            subs.append([("L", q[i], q[(i + 1) % 4]) for i in range(4)])
            continue
        if k == "l":
            seg = ("L", P(it[1]), P(it[2]))
        elif k == "c":
            p0, c1, c2, p1 = P(it[1]), P(it[2]), P(it[3]), P(it[4])
            kind = bez_kind(p0, c1, c2, p1, tol)
            if kind is None:
                seg = ("B", p0, c1, c2, p1)
            elif kind[0] == "L":
                seg = ("L", p0, p1)
            else:
                seg = ("A", p0, p1, kind[1], kind[2], kind[3], kind[4])
        else:
            continue
        if last is not None and _d(last, seg[1]) > tol:
            subs.append(cur)
            cur = []
        if seg[0] == "L" and _d(seg[1], seg[2]) < 1e-9:
            last = seg[2]
            continue
        cur.append(seg)
        last = seg[-1] if seg[0] == "B" else seg[2]
    if cur:
        subs.append(cur)
    return [s for s in subs if s]


def _end(seg):
    return seg[4] if seg[0] == "B" else seg[2]


def _merge_arcs(sub, tol):
    out = []
    for s in sub:
        if out and s[0] == "A" and out[-1][0] == "A":
            a = out[-1]
            if _d(a[3], s[3]) <= max(tol, a[4] * 3e-3) and abs(a[4] - s[4]) <= max(tol, a[4] * 3e-3) and a[5] == s[5]:
                out[-1] = ("A", a[1], s[2], a[3], a[4], a[5], a[6] + s[6])
                continue
        out.append(s)
    return out


def _arcs_from_lines(sub, tol):
    """Serie di almeno 5 segmenti corti, di lunghezza simile e con la stessa curvatura -> un arco (o un cerchio)."""
    out, i, n = [], 0, len(sub)
    while i < n:
        if sub[i][0] != "L":
            out.append(sub[i])
            i += 1
            continue
        j = i
        while j < n and sub[j][0] == "L":
            j += 1
        run = sub[i:j]
        out.extend(_fit_run(run, tol))
        i = j
    return out


def _fit_run(run, tol):
    if len(run) < 5:
        return run
    pts = [run[0][1]] + [s[2] for s in run]
    lens = [_d(s[1], s[2]) for s in run]
    res, k, m = [], 0, len(run)
    while k < m:
        best = None
        e = k + 5
        while e <= m:
            seg_l = lens[k:e]
            if max(seg_l) > 2.2 * min(seg_l) + tol:
                break
            sign = None
            ok = True
            for q in range(k + 1, e):
                cr = _cross(pts[q - 1], pts[q], pts[q + 1])
                tv = math.degrees(math.asin(max(-1, min(1, cr / max(lens[q - 1] * lens[q], 1e-12)))))
                if abs(tv) < 0.05 or abs(tv) > 22.5:
                    ok = False
                    break
                sg = tv > 0
                if sign is None:
                    sign = sg
                elif sg != sign:
                    ok = False
                    break
            if not ok:
                break
            fc = fit_circle(pts[k:e + 1])
            if not fc or fc[3] > max(tol, fc[2] * 4e-3):
                break
            best = (e, fc, sign)
            e += 1
        if best:
            e, fc, ccw = best
            c, r = (fc[0], fc[1]), fc[2]
            p0, p1 = pts[k], pts[e]
            sw = 0.0
            for q in range(k, e):  # ampiezza = somma degli angoli dei segmenti
                a0, a1 = _ang(c, pts[q]), _ang(c, pts[q + 1])
                sw += ((a1 - a0) % 360) if ccw else ((a0 - a1) % 360)
            res.append(("A", p0, p1, c, r, ccw, min(sw, 360.0)))
            k = e
        else:
            res.append(run[k])
            k += 1
    return res


# ---------------------------------------------------------------- colori, spessori, tratteggi
LINEWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211]


def rgb_int(c):
    if not c:
        return None
    if len(c) == 1:
        c = (c[0], c[0], c[0])
    elif len(c) == 4:  # CMYK
        k = c[3]
        c = ((1 - c[0]) * (1 - k), (1 - c[1]) * (1 - k), (1 - c[2]) * (1 - k))
    r, g, b = (max(0, min(255, round(v * 255))) for v in c[:3])
    return (r << 16) | (g << 8) | b


def lineweight(width_pt):
    if not width_pt or width_pt <= 0:
        return -3  # predefinito
    mm100 = width_pt * 25.4 / 72 * 100
    return min(LINEWEIGHTS, key=lambda v: abs(v - mm100))


def dash_pattern(dashes):
    if not dashes:
        return None
    m = re.match(r"\s*\[([^\]]*)\]", dashes)
    if not m:
        return None
    nums = [float(x) for x in m.group(1).replace(",", " ").split() if x]
    if not nums or sum(nums) < 0.3:
        return None
    if len(nums) % 2:
        nums = nums * 2
    return tuple(round(v, 3) for v in nums)


# ---------------------------------------------------------------- caratteri
def font_info(name: str):
    """Nome del carattere PDF ("ABCDEF+Arial-BoldMT") -> (famiglia, grassetto, corsivo)."""
    n = (name or "").split("+", 1)[-1]
    base, _, style = n.partition("-")
    st = (style or "").lower()
    low = n.lower()
    bold = "bold" in low or "black" in low or "heavy" in low or st.endswith("bd") or ",bold" in low
    italic = "italic" in low or "oblique" in low or st.endswith("it") or st.endswith("i") and len(st) <= 2
    base = base.split(",")[0]
    base = re.sub(r"(PSMT|PS|MT)$", "", base)
    fam = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base).strip() or "Arial"
    return fam, bold, italic


@lru_cache(maxsize=256)
def font_file(fam: str, bold: bool, italic: bool):
    try:
        from .publisher import _font_file
        f, _, _ = _font_file(fam, bold, italic)
        return f
    except Exception:  # noqa: BLE001
        return None


@lru_cache(maxsize=256)
def cap_ratio(path):
    """Altezza delle maiuscole / em del carattere (l'altezza dei TEXT nei DXF e' quella delle maiuscole)."""
    if path:
        try:
            from fontTools.ttLib import TTFont
            f = TTFont(path, fontNumber=0, lazy=True)
            cap = getattr(f["OS/2"], "sCapHeight", 0) or 0
            upm = f["head"].unitsPerEm
            if cap > 0 and upm:
                return cap / upm
        except Exception:  # noqa: BLE001
            pass
    return 0.716


@lru_cache(maxsize=256)
def _mu_font(path):
    try:
        return pymupdf.Font(fontfile=path) if path else pymupdf.Font("helv")
    except Exception:  # noqa: BLE001
        return pymupdf.Font("helv")


# ---------------------------------------------------------------- testi
def _texts(page, H, layer_of, opts):
    out = []
    try:
        spans = page.get_texttrace()
    except Exception:  # noqa: BLE001
        return out
    runs = []
    for s in spans:
        chars = s.get("chars") or ()
        if not chars:
            continue
        dx, dy = s["dir"]
        size = float(s["size"]) or 1.0
        fam0, b0, i0 = font_info(s.get("font", ""))
        mf = _mu_font(font_file(fam0, b0, i0))
        cur = None
        for ch in chars:
            u, _, org, bbox = ch[0], ch[1], ch[2], ch[3]
            c = chr(u) if u >= 0 else "?"
            if cur is not None:
                # distanza lungo la direzione del testo tra la fine del carattere precedente e questo
                gap = (org[0] - cur["end"][0]) * dx + (org[1] - cur["end"][1]) * dy
                off = abs(-(org[0] - cur["org"][0]) * dy + (org[1] - cur["org"][1]) * dx)
                if gap > size * 1.5 or gap < -size * 0.5 or off > size * 0.2:
                    runs.append(cur)
                    cur = None
                elif gap > size * 0.22 and not cur["s"].endswith(" ") and c != " ":
                    cur["s"] += " "
            if cur is None:
                cur = {"s": "", "org": org, "span": s, "end": org}
            cur["s"] += c
            # fine del carattere = origine + avanzamento: larghezza del glifo nel carattere scelto, oppure il riquadro
            # (solo per il testo orizzontale/verticale: il riquadro di un testo inclinato e' piu' largo del carattere)
            try:
                w = mf.text_length(c, fontsize=size)
            except Exception:  # noqa: BLE001
                w = 0
            if not w:
                w = abs((bbox[2] - bbox[0]) * dx + (bbox[3] - bbox[1]) * dy)
            cur["end"] = (org[0] + dx * w, org[1] + dy * w)
        if cur is not None:
            runs.append(cur)
    # pezzi consecutivi dello stesso testo scritti con piu' operatori (un carattere alla volta): si riuniscono
    merged = []
    for r in runs:
        s = r["span"]
        if merged:
            p = merged[-1]
            ps = p["span"]
            if (ps["font"] == s["font"] and abs(ps["size"] - s["size"]) < 0.01 and ps["dir"] == s["dir"] and ps.get("color") == s.get("color")
                    and ps.get("layer") == s.get("layer") and ps.get("type") == s.get("type")):
                dx, dy = s["dir"]
                size = float(s["size"]) or 1.0
                gap = (r["org"][0] - p["end"][0]) * dx + (r["org"][1] - p["end"][1]) * dy
                off = abs(-(r["org"][0] - p["org"][0]) * dy + (r["org"][1] - p["org"][1]) * dx)
                if -size * 0.3 < gap < size * 1.2 and off < size * 0.2:
                    p["s"] += (" " if gap > size * 0.22 and not p["s"].endswith(" ") and not r["s"].startswith(" ") else "") + r["s"]
                    p["end"] = r["end"]
                    continue
        merged.append(dict(r))
    for r in merged:
        txt = r["s"].strip()
        if not txt or all(ch in "�\x00" for ch in txt):
            continue
        s = r["span"]
        lead = len(r["s"]) - len(r["s"].lstrip())
        dx, dy = s["dir"]
        size = float(s["size"]) or 1.0
        fam, bold, italic = font_info(s.get("font", ""))
        ff = font_file(fam, bold, italic)
        h = size * cap_ratio(ff)
        org = r["org"]
        rot = math.degrees(math.atan2(-dy, dx)) % 360
        # larghezza misurata / larghezza del carattere scelto = fattore di larghezza del TEXT
        meas = (r["end"][0] - org[0]) * dx + (r["end"][1] - org[1]) * dy
        wf = 1.0
        try:
            exp = _mu_font(ff).text_length(r["s"].rstrip(), fontsize=size)
            if exp > 0 and meas > 0:
                wf = meas / exp
                wf = 1.0 if abs(wf - 1) < 0.04 or not (0.3 < wf < 3) else round(wf, 3)
        except Exception:  # noqa: BLE001
            pass
        if lead:  # spazi iniziali: l'origine si sposta sul primo carattere visibile
            try:
                adv = _mu_font(ff).text_length(r["s"][:lead], fontsize=size) * wf
                org = (org[0] + dx * adv, org[1] + dy * adv)
            except Exception:  # noqa: BLE001
                pass
        hidden = s.get("type") == 3 or (s.get("opacity") is not None and s.get("opacity") == 0)
        out.append({"t": "text", "p": [org[0], H - org[1]], "h": h, "rot": round(rot, 4), "s": txt, "font": fam, "bold": bold, "italic": italic,
                    "file": ff, "wf": wf, "col": rgb_int(s.get("color")), "L": layer_of(s.get("layer"), None, None, "text", hidden),
                    "_size": size})
    if opts.get("mtext", True):
        out = _paragraphs(out)
    for e in out:
        e.pop("_size", None)
    return out


def _paragraphs(texts):
    """Righe allineate a sinistra, stesso carattere/altezza/rotazione/colore, interlinea regolare -> un MTEXT."""
    used = [False] * len(texts)
    out = []
    order = sorted(range(len(texts)), key=lambda i: (texts[i]["rot"], -_rot_y(texts[i]), _rot_x(texts[i])))
    for a, i in enumerate(order):
        if used[i]:
            continue
        e = texts[i]
        used[i] = True
        group = [e]
        step = None
        for j in order[a + 1:]:
            if used[j]:
                continue
            f = texts[j]
            last = group[-1]
            if (f["rot"] != e["rot"] or f["font"] != e["font"] or abs(f["h"] - e["h"]) > e["h"] * 0.02 or f["col"] != e["col"] or f["L"] != e["L"]
                    or f["bold"] != e["bold"] or f["italic"] != e["italic"]):
                continue
            dy = _rot_y(last) - _rot_y(f)
            dx = abs(_rot_x(f) - _rot_x(last))
            if dx > e["h"] * 0.3:
                continue
            if not (e["h"] * 1.2 < dy < e["h"] * 2.6):
                if dy >= e["h"] * 2.6:
                    break
                continue
            if step is not None and abs(dy - step) > e["h"] * 0.15:
                break
            step = dy
            group.append(f)
            used[j] = True
        if len(group) == 1:
            out.append(e)
            continue
        r = math.radians(e["rot"])
        # punto di inserimento in alto a sinistra: dalla linea di base della prima riga si sale dell'altezza delle maiuscole
        p = (e["p"][0] - math.sin(r) * e["h"], e["p"][1] + math.cos(r) * e["h"])
        out.append({"t": "mtext", "p": list(p), "h": e["h"], "rot": e["rot"], "lines": [g["s"] for g in group], "spacing": step,
                    "font": e["font"], "bold": e["bold"], "italic": e["italic"], "file": e["file"], "wf": e["wf"], "col": e["col"], "L": e["L"]})
    return out


def _rot_x(e):
    r = math.radians(e["rot"])
    return e["p"][0] * math.cos(r) + e["p"][1] * math.sin(r)


def _rot_y(e):
    r = math.radians(e["rot"])
    return -e["p"][0] * math.sin(r) + e["p"][1] * math.cos(r)


# ---------------------------------------------------------------- pagina -> entita'
def page_info(page) -> dict:
    """Che cosa c'e' nella pagina: tracciati, testo, immagini (una scansione = una grande immagine e quasi niente altro)."""
    try:
        nd = len(page.get_cdrawings())
    except Exception:  # noqa: BLE001
        nd = len(page.get_drawings())
    txt = page.get_text()
    area = abs(page.rect)
    img_cover = 0.0
    try:
        for im in page.get_image_info():
            b = pymupdf.Rect(im["bbox"]) & page.rect
            img_cover = max(img_cover, abs(b) / area if area else 0)
    except Exception:  # noqa: BLE001
        pass
    raster = img_cover > 0.6 and nd < 50
    sc = SCALE_RE.findall(txt)
    if not sc:
        sc = [m for m in RATIO_RE.findall(txt) if 1 < int(m) <= 5000]
    scales = []
    for m in sc:
        v = int(m)
        if v not in scales and 1 <= v <= 5000:
            scales.append(v)
    return {"w": page.rect.width, "h": page.rect.height, "drawings": nd, "chars": len(txt.strip()), "image_cover": round(img_cover, 3),
            "raster": raster, "scales": scales[:6]}


def extract(page, opts: dict, layers: dict) -> list:
    """Entita' di una pagina in punti PDF, y verso l'alto. `layers` si riempie con {nome: {"c": colore, "lw": spessore, "off": bool}}."""
    H = page.rect.height
    tol = float(opts.get("tol", 0.08))
    mode = opts.get("layers", "auto")
    want_arcs = opts.get("arcs", True)
    seg_arcs = opts.get("seg_arcs", True)
    skip_white = opts.get("skip_white", True)
    fills = opts.get("fills", "hatch")  # hatch | none
    drawings = page.get_drawings()
    has_ocg = any(d.get("layer") for d in drawings)
    page_area = abs(page.rect)
    T = {"text": tr("srv_drawing.layer_testi"), "hidden": tr("srv_drawing.layer_testi_nascosti"), "fill": tr("srv_drawing.layer_riempimenti"),
         "one": tr("srv_drawing.layer_disegno")}

    def safe(n):
        n = re.sub(r'[<>/\\":;?*|=`,]', "_", n).strip() or "0"
        return n[:250]

    def layer_of(ocg, color, lw, kind, hidden=False):
        if kind == "text" and hidden:
            name = T["hidden"] + (f"-{safe(ocg)}" if ocg and mode in ("auto", "ocg") else "")
            layers.setdefault(name, {"c": None, "lw": -3, "off": True})
            return name
        if ocg and mode in ("auto", "ocg"):
            name = safe(ocg)
            layers.setdefault(name, {"c": None, "lw": -3})
            return name
        if kind == "text":
            name = T["text"]
            layers.setdefault(name, {"c": None, "lw": -3})
            return name
        if mode == "single" or mode == "ocg":
            name = T["one"]
            layers.setdefault(name, {"c": None, "lw": -3})
            return name
        col = color if color is not None else 0
        hexc = f"{col:06X}"
        if kind == "fill":
            name = f"{T['fill']}-{hexc}"
            layers.setdefault(name, {"c": col, "lw": -3})
        else:
            mm = "%.2f" % (max(lw, 0) / 100) if lw is not None and lw >= 0 else "0.00"
            name = f"C{hexc}-{mm}"
            layers.setdefault(name, {"c": col, "lw": lw})
        return name

    ents = []
    for d in drawings:
        r = d.get("rect")
        if r is not None:  # fuori dalla pagina (le linee orizzontali/verticali hanno un riquadro vuoto: niente Rect.intersects)
            pr = page.rect
            if r[2] < pr.x0 - 1 or r[0] > pr.x1 + 1 or r[3] < pr.y0 - 1 or r[1] > pr.y1 + 1:
                continue
        subs = _subpaths(d["items"], H, tol)
        if not subs:
            continue
        typ = d.get("type") or "s"
        ocg = d.get("layer") or None
        if not want_arcs:  # archi riconosciuti -> di nuovo Bezier generiche (spline)
            subs = [[s if s[0] != "A" else _arc_as_bez(s) for s in sub] for sub in subs]
        subs = [_merge_arcs(sub, tol) for sub in subs]
        if seg_arcs and want_arcs:
            subs = [_merge_arcs(_arcs_from_lines(sub, max(tol, 0.12)), tol) for sub in subs]
        # riempimento
        if "f" in typ and fills != "none":
            fc = rgb_int(d.get("fill"))
            white = fc == 0xFFFFFF
            big = r is not None and abs(pymupdf.Rect(r)) > page_area * 0.85
            if not (white and (skip_white or big)) and not (big and typ == "f"):
                paths = [_poly_vertices(sub, close=True) for sub in subs]
                paths = [p for p in paths if len(p) >= 3]
                if paths:
                    e = {"t": "hatch", "paths": paths, "col": fc, "L": layer_of(ocg, fc, None, "fill"), "evenodd": bool(d.get("even_odd"))}
                    op = d.get("fill_opacity")
                    if op is not None and op < 0.999:
                        e["alpha"] = round(op, 3)
                    ents.append(e)
        if "s" not in typ:
            continue
        col = rgb_int(d.get("color"))
        lw = lineweight(d.get("width"))
        lt = dash_pattern(d.get("dashes"))
        L = layer_of(ocg, col, lw, "line")
        attrs = {"col": col, "lw": lw, "L": L}
        if lt:
            attrs["lt"] = lt
        for i, sub in enumerate(subs):
            closed = _d(sub[0][1], _end(sub[-1])) <= tol
            if d.get("closePath") and i == len(subs) - 1 and not closed:
                sub = sub + [("L", _end(sub[-1]), sub[0][1])]
                closed = True
            ents.extend(_emit(sub, closed, attrs, tol))
    ents.extend(_texts(page, H, layer_of, opts) if opts.get("texts", True) else [])
    return ents


def _arc_as_bez(s):
    _, p0, p1, c, r, ccw, sw = s
    # un arco fino a 90 gradi -> una Bezier (k = 4/3 tan(sw/4))
    a0 = math.atan2(p0[1] - c[1], p0[0] - c[0])
    a1 = a0 + math.radians(sw) * (1 if ccw else -1)
    k = 4 / 3 * math.tan((a1 - a0) / 4)
    c1 = (p0[0] - k * r * math.sin(a0), p0[1] + k * r * math.cos(a0))
    c2 = (p1[0] + k * r * math.sin(a1), p1[1] - k * r * math.cos(a1))
    return ("B", p0, c1, c2, p1)


def _poly_vertices(sub, close=False):
    """Segmenti -> vertici [x, y, bulge] (le Bezier generiche si campionano)."""
    v = []
    for s in sub:
        if s[0] == "L":
            v.append([s[1][0], s[1][1], 0.0])
        elif s[0] == "A":
            sw = s[6]
            if sw >= 359.9:  # cerchio intero in un pezzo solo: due mezze circonferenze
                c, r, ccw = s[3], s[4], s[5]
                opp = (2 * c[0] - s[1][0], 2 * c[1] - s[1][1])
                b = 1.0 if ccw else -1.0
                v.append([s[1][0], s[1][1], b])
                v.append([opp[0], opp[1], b])
                continue
            v.append([s[1][0], s[1][1], bulge_of(s[3], s[1], s[2], s[5], sw)])
        else:
            for k in range(8):
                p = _bez(s[1], s[2], s[3], s[4], k / 8)
                v.append([p[0], p[1], 0.0])
    if not close:
        e = _end(sub[-1])
        v.append([e[0], e[1], 0.0])
    elif v and _d(v[0], _end(sub[-1])) > 1e-6:
        e = _end(sub[-1])
        v.append([e[0], e[1], 0.0])
    return v


def _emit(sub, closed, attrs, tol):
    out = []
    if len(sub) == 1:
        s = sub[0]
        if s[0] == "L":
            return [{"t": "line", "p": [*s[1], *s[2]], **attrs}]
        if s[0] == "A":
            return [_arc_ent(s, attrs)]
        return [{"t": "spline", "cp": [s[1], s[2], s[3], s[4]], **attrs}]
    # cerchio fatto di archi con lo stesso centro (gia' uniti in _merge_arcs) e chiuso
    if all(s[0] == "A" for s in sub) and closed:
        c, r = sub[0][3], sub[0][4]
        if all(_d(s[3], c) <= max(tol, r * 3e-3) and abs(s[4] - r) <= max(tol, r * 3e-3) for s in sub) and sum(s[6] for s in sub) > 359:
            return [{"t": "circle", "c": list(c), "r": r, **attrs}]
    # pezzi: corse di linee/archi -> polilinea, corse di Bezier -> spline
    runs, cur = [], []
    for s in sub:
        if cur and (s[0] == "B") != (cur[-1][0] == "B"):
            runs.append(cur)
            cur = []
        cur.append(s)
    runs.append(cur)
    whole = len(runs) == 1
    for run in runs:
        if run[0][0] == "B":
            cp = [run[0][1]]
            for s in run:
                cp += [s[2], s[3], s[4]]
            out.append({"t": "spline", "cp": cp, **attrs})
        elif len(run) == 1 and not (whole and closed):
            s = run[0]
            out.append({"t": "line", "p": [*s[1], *s[2]], **attrs} if s[0] == "L" else _arc_ent(s, attrs))
        else:
            cl = whole and closed
            out.append({"t": "poly", "v": _poly_vertices(run, close=cl), "closed": cl, **attrs})
    return out


def _arc_ent(s, attrs):
    _, p0, p1, c, r, ccw, sw = s
    if sw >= 359.9:
        return {"t": "circle", "c": list(c), "r": r, **attrs}
    a0, a1 = _ang(c, p0), _ang(c, p1)
    if not ccw:
        a0, a1 = a1, a0
    return {"t": "arc", "c": list(c), "r": r, "a": [a0, a1], **attrs}
