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

from . import pdfclip
from .i18n import t as tr

ACI_STD = {(255, 0, 0): 1, (255, 255, 0): 2, (0, 255, 0): 3, (0, 255, 255): 4, (0, 0, 255): 5, (255, 0, 255): 6, (0, 0, 0): 7, (255, 255, 255): 7}
SCALE_RE = re.compile(r"(?:SCALA|SCALE|ECHELLE|ÉCHELLE|ESCALA|MAßSTAB|MASSSTAB|SC\.)\s*:?\s*1\s*[:/]\s*(\d{1,5})", re.I)
RATIO_RE = re.compile(r"(?<![\d.,])1\s*:\s*(\d{1,5})(?![\d.,])")
# scale anglosassoni: 1" = 20' (1:240), 1/4" = 1'-0" (1:48)
IMP_RE = re.compile(r"(?<![\d/])(\d{1,2})(?:/(\d{1,2}))?\s*(?:\"|''|IN\b)\s*=\s*(\d{1,4})\s*(?:'|FT\b)", re.I)


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
def page_transform(page):
    """Coordinate di get_drawings/get_texttrace (pagina NON ruotata) -> coordinate della pagina come si vede (/Rotate
    applicato), con y verso l'alto. Restituisce (P(x, y) -> (x', y'), V(dx, dy) -> direzione come si vede, y verso il basso)."""
    m = page.rotation_matrix
    a, b, c, d, e, f = m.a, m.b, m.c, m.d, m.e, m.f
    H = page.rect.height

    def P(x, y):
        return (a * x + c * y + e, H - (b * x + d * y + f))

    def V(dx, dy):
        return (a * dx + c * dy, b * dx + d * dy)
    return P, V


def _subpaths(items, T, tol):
    """Elementi di get_drawings -> sottotracciati: liste di segmenti ("L", p0, p1) / ("A", p0, p1, c, r, ccw, sw) / ("B", p0, c1, c2, p1)
    in coordinate della pagina come si vede, con y verso l'alto (T = page_transform)."""
    def P(p):
        return T(float(p.x), float(p.y))
    subs, cur, last = [], [], None
    for it in items:
        k = it[0]
        if k == "re":
            if cur:
                subs.append(cur)
                cur, last = [], None
            r = it[1]
            q = [T(float(x), float(y)) for x, y in ((r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1))]
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
    """Segmenti consecutivi -> archi dove i vertici stanno su un cerchio. Lineare: curvature e lunghezze si esaminano una volta,
    poi la corsa piu' lunga che regge il cerchio si cerca per bisezione (prima: un cerchio ai minimi quadrati a ogni passo)."""
    if len(run) < 5:
        return run
    pts = [run[0][1]] + [s[2] for s in run]
    lens = [_d(s[1], s[2]) for s in run]
    m = len(run)
    turn = [0.0] * (m + 1)  # angolo di svolta nel vertice q (tra il segmento q-1 e q), con segno
    for q in range(1, m):
        cr = _cross(pts[q - 1], pts[q], pts[q + 1])
        turn[q] = math.degrees(math.asin(max(-1, min(1, cr / max(lens[q - 1] * lens[q], 1e-12)))))

    def circle_ok(k, e):
        c = _circ3(pts[k], pts[(k + e) // 2], pts[e])
        if c is None:
            return None
        r = _d(c, pts[k])
        if r > 1e6:
            return None
        lim = max(tol, r * 4e-3)
        for q in range(k, e + 1):
            if abs(_d(c, pts[q]) - r) > lim:
                return None
        return c, r

    res, k = [], 0
    while k < m:
        # corsa massima con svolte nello stesso verso, tra 0,05 e 22,5 gradi, e lunghezze simili
        e = k + 1
        lo_l = hi_l = lens[k]
        sign = None
        while e < m:
            tv = turn[e]
            if abs(tv) < 0.05 or abs(tv) > 22.5 or (sign is not None and (tv > 0) != sign):
                break
            lo_l, hi_l = min(lo_l, lens[e]), max(hi_l, lens[e])
            if hi_l > 2.2 * lo_l + tol:
                break
            sign = tv > 0
            e += 1
        best = None
        if e - k >= 5:
            lo, hi = k + 5, e
            if circle_ok(k, lo):
                while lo < hi:  # piu' lungo possibile
                    mid = (lo + hi + 1) // 2
                    if circle_ok(k, mid):
                        lo = mid
                    else:
                        hi = mid - 1
                fc = fit_circle(pts[k:lo + 1])
                if fc and fc[3] <= max(tol, fc[2] * 4e-3):
                    best = (lo, fc, sign)
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
def _texts(page, T, V, layer_of, opts):
    out = []
    W, H = page.rect.width, page.rect.height
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
                # oltre un paio di spazi (tabulazioni, colonne di una tabella) il testo si divide: ogni pezzo resta al suo posto
                if gap > size * 0.75 or gap < -size * 0.5 or off > size * 0.2:
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
                if -size * 0.3 < gap < size * 0.75 and off < size * 0.2:
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
        vx, vy = V(dx, dy)
        rot = math.degrees(math.atan2(-vy, vx)) % 360
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
        pos = T(org[0], org[1])
        if not (-1 <= pos[0] <= W + 1 and -1 <= pos[1] <= H + 1):  # fuori dalla pagina
            continue
        out.append({"t": "text", "p": list(pos), "h": h, "rot": round(rot, 4), "s": txt, "font": fam, "bold": bold, "italic": italic,
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
    for a, b, ft in IMP_RE.findall(txt.replace("’", "'").replace("”", '"')):
        inch = int(a) / int(b) if b else int(a)
        if inch > 0:
            sc.append(str(round(int(ft) * 12 / inch)))
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
    drawings = page.get_drawings(extended=True)
    has_ocg = any(d.get("layer") for d in drawings)
    page_area = abs(page.rect)
    LN = {"text": tr("srv_drawing.layer_testi"), "hidden": tr("srv_drawing.layer_testi_nascosti"), "fill": tr("srv_drawing.layer_riempimenti"),
         "one": tr("srv_drawing.layer_disegno"), "image": tr("srv_drawing.layer_immagini"),
          "drawn": tr("srv_drawing.layer_testi_tratti")}

    def safe(n):
        n = re.sub(r'[<>/\\":;?*|=`,]', "_", n).strip() or "0"
        return n[:250]

    def layer_of(ocg, color, lw, kind, hidden=False):
        if kind == "text" and hidden:
            name = LN["hidden"] + (f"-{safe(ocg)}" if ocg and mode in ("auto", "ocg") else "")
            layers.setdefault(name, {"c": None, "lw": -3, "off": True})
            return name
        if ocg and mode in ("auto", "ocg"):
            name = safe(ocg)
            layers.setdefault(name, {"c": None, "lw": -3})
            return name
        if kind == "drawn":
            name = LN["drawn"]
            layers.setdefault(name, {"c": None, "lw": -3, "off": True})
            return name
        if kind == "image":
            name = LN["image"]
            layers.setdefault(name, {"c": None, "lw": -3})
            return name
        if kind == "text":
            name = LN["text"]
            layers.setdefault(name, {"c": None, "lw": -3})
            return name
        if mode == "single" or mode == "ocg":
            name = LN["one"]
            layers.setdefault(name, {"c": None, "lw": -3})
            return name
        col = color if color is not None else 0
        hexc = f"{col:06X}"
        if kind == "fill":
            name = f"{LN['fill']}-{hexc}"
            layers.setdefault(name, {"c": col, "lw": -3})
        else:
            mm = "%.2f" % (max(lw, 0) / 100) if lw is not None and lw >= 0 else "0.00"
            name = f"C{hexc}-{mm}"
            layers.setdefault(name, {"c": col, "lw": lw})
        return name

    order, masks = [], []  # entita' nell'ordine di disegno: ("e", entita') o ("s", tratti da emettere alla fine)
    masks_on = opts.get("masks", True)
    T, V = page_transform(page)
    W = page.rect.width
    page_rg = pdfclip.Region(rect=(-0.5, -0.5, W + 0.5, H + 0.5))
    clips = pdfclip.Stack()
    for d in drawings:
        typ = d.get("type") or "s"
        level = d.get("level", 0)
        if typ == "clip":
            reg = _clip_region(d, T, tol)
            if reg is not None:
                clips.push(level, reg)
            else:
                clips.at(level)
            continue
        if typ == "group":
            clips.at(level)
            continue
        regions = [page_rg] + clips.at(level)
        subs = _subpaths(d["items"], T, tol)
        if not subs:
            continue
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
            r = d.get("rect")
            big = r is not None and abs(pymupdf.Rect(r)) > page_area * 0.85
            if white and not big and masks_on:
                # riempimento bianco = mascheratura: nasconde cio' che e' stato disegnato prima sotto di lui
                rg = pdfclip.Region(polys=[pdfclip.sample_sub(sub) for sub in subs], evenodd=bool(d.get("even_odd")), margin=0)
                if rg.rect is not None:
                    masks.append((len(order), rg.hole()))
            if not (white and (skip_white or big)) and not (big and typ == "f"):
                paths = []
                for sub in subs:
                    pv = _poly_vertices(sub, close=True)
                    if len(pv) < 3:
                        continue
                    for rg in regions:
                        if pv is None:
                            break
                        xs, ys = [v[0] for v in pv], [v[1] for v in pv]
                        bb = (min(xs), min(ys), max(xs), max(ys))
                        if rg.inside_box(bb):
                            continue
                        if rg.outside_box(bb):
                            pv = None
                            break
                        cp = rg.clip_poly(pdfclip.sample_sub(sub) if any(v[2] for v in pv) or len(pv) != len(sub) else [(v[0], v[1]) for v in pv])
                        pv = [[q[0], q[1], 0.0] for q in cp] if cp else None
                    if pv and len(pv) >= 3:
                        paths.append(pv)
                if paths:
                    e = {"t": "hatch", "paths": paths, "col": fc, "L": layer_of(ocg, fc, None, "fill"), "evenodd": bool(d.get("even_odd"))}
                    op = d.get("fill_opacity")
                    if op is not None and op < 0.999:
                        e["alpha"] = round(op, 3)
                    order.append(("e", e))
        if "s" not in typ:
            continue
        col = rgb_int(d.get("color"))
        if col == 0xFFFFFF and skip_white:
            continue  # contorno bianco: sulla carta non si vede (bordi delle mascherature dei testi)
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
            pieces = pdfclip.apply([sub], regions)
            if len(pieces) == 1 and len(pieces[0]) == len(sub) and pieces[0][0][1] == sub[0][1]:
                pieces = [(sub, closed)]
            else:
                pieces = [(pc, False) for pc in pieces]
            if pieces:
                order.append(("s", {"pieces": pieces, "attrs": attrs, "ocg": ocg, "box": _box_of(pc for pc, _ in pieces)}))
    _apply_masks(order, masks)
    shx, rejected = _shx_texts(page, T, order, layer_of, opts) if opts.get("shx", True) else ([], [])
    real = _texts(page, T, V, layer_of, {**opts, "mtext": False}) if opts.get("texts", True) else []
    if opts.get("shx", True):  # testo invisibile sopra i tratti (altro modo di AutoCAD di conservare i testi SHX)
        real, more = _shx_from_hidden(real, order, layer_of, LN["hidden"])
        shx += more
    if opts.get("mtext", True):
        real = _paragraphs(real)
    ocr = opts.get("drawn_text", "auto")  # auto | on | off
    visible = sum(len(e.get("s") or "".join(e.get("lines", []))) for e in real if not e["L"].startswith(LN["hidden"]))
    if ocr == "on" or (ocr == "auto" and not shx and visible < 80 and len(order) > 0):
        shx += _drawn_texts(page, order, layer_of, opts)
    elif rejected and ocr != "off":  # paragrafi SHX con il commento inaffidabile: OCR solo in quelle zone
        shx += _drawn_texts(page, order, layer_of, opts, zones=rejected)
    ents = []
    dashes = opts.get("dashes", True)
    buf, battrs = [], None

    def flush():
        if not buf:
            return
        chains = _dash_chains(buf, tol, seg_arcs and want_arcs) if dashes else [(a, b, None) for a, b in buf]
        for pc, closed, lt in chains:
            ents.extend(_emit(pc, closed, {**battrs, "lt": lt} if lt and not battrs.get("lt") else battrs, tol))
        buf.clear()
    # i trattini di una linea tratteggiata sono spesso tracciati separati e consecutivi con lo stesso stile: si esaminano insieme
    for kind, v in order:
        if kind == "x":
            continue
        if kind == "e":
            flush()
            ents.append(v)
        elif v["pieces"]:
            if battrs is None or v["attrs"] != battrs:
                flush()
                battrs = v["attrs"]
            buf.extend(v["pieces"])
    flush()
    ents.extend(shx)
    if opts.get("images", True):
        ents.extend(_images(page, T, layer_of))
    ents.extend(real)
    return ents


def _sub_len(sub):
    n = 0.0
    for sg in sub:
        if sg[0] == "L":
            n += _d(sg[1], sg[2])
        elif sg[0] == "A":
            n += sg[4] * math.radians(sg[6])
        else:
            n += _d(sg[1], sg[2]) + _d(sg[2], sg[3]) + _d(sg[3], sg[4])
    return n


def _dir_at(sub, end):
    sg = sub[-1] if end else sub[0]
    if sg[0] == "L":
        a, b = sg[1], sg[2]
    elif sg[0] == "B":
        a, b = (sg[3], sg[4]) if end else (sg[1], sg[2])
    else:
        a, b = sg[1], sg[2]
        c = sg[3]
        q = b if end else a
        t = (-(q[1] - c[1]), q[0] - c[0]) if sg[5] else (q[1] - c[1], -(q[0] - c[0]))
        n = math.hypot(*t) or 1.0
        return (t[0] / n, t[1] / n)
    n = _d(a, b)
    return ((b[0] - a[0]) / n, (b[1] - a[1]) / n) if n > 1e-12 else (0.0, 0.0)


def _merge_collinear(segs, tol):
    """Segmenti consecutivi sulla stessa retta -> uno solo."""
    out = []
    for sg in segs:
        if out and sg[0] == "L" and out[-1][0] == "L":
            a, b, c = out[-1][1], out[-1][2], sg[2]
            if _d(a, c) > 1e-9 and _line_dist(b, a, c) <= tol * 0.5 and (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) > 0:
                out[-1] = ("L", a, c)
                continue
        out.append(sg)
    return out


def _pattern(dash, gaps):
    """Lunghezze dei trattini e delle pause -> schema del tipo di linea (trattino, pausa[, punto, pausa])."""
    ds = sorted(dash)
    g = sorted(gaps)[len(gaps) // 2]
    lo, hi = ds[0], ds[-1]
    if hi <= lo * 1.6 + 0.05:
        return (round(ds[len(ds) // 2], 3), round(g, 3))
    # due famiglie (linea d'asse: lungo, pausa, corto, pausa)
    mid = (lo + hi) / 2
    long_ = [d for d in dash if d >= mid]
    short = [d for d in dash if d < mid]
    return (round(sorted(long_)[len(long_) // 2], 3), round(g, 3), round(max(sorted(short)[len(short) // 2], 0.0), 3), round(g, 3))


def _dash_chains(pieces, tol, fit_arcs):
    """Linee tratteggiate scritte come tanti trattini separati (cosi' esportano AutoCAD e quasi tutti i CAD): i trattini in fila,
    con pause regolari e nella stessa direzione, diventano UNA linea/polilinea con il suo tipo di linea."""
    out, n, i = [], len(pieces), 0
    lens = [_sub_len(pc) for pc, _ in pieces]
    while i < n:
        j = i
        if not pieces[i][1]:
            gaps = []
            while j + 1 < n and not pieces[j + 1][1]:
                a, b = pieces[j][0], pieces[j + 1][0]
                e, s0 = _end(a[-1]), b[0][1]
                g = _d(e, s0)
                if g < 0.05 or g > 12:
                    break
                d0, d1 = _dir_at(a, True), _dir_at(b, False)
                gv = ((s0[0] - e[0]) / g, (s0[1] - e[1]) / g)
                if d0[0] * gv[0] + d0[1] * gv[1] < 0.94 or d1[0] * gv[0] + d1[1] * gv[1] < 0.94:
                    break
                if gaps:
                    med = sorted(gaps)[len(gaps) // 2]
                    if not (med * 0.6 - 0.05 <= g <= med * 1.6 + 0.05):
                        break
                if lens[j + 1] > 40 * g + 20:
                    break
                gaps.append(g)
                j += 1
        if j - i + 1 >= 3:
            dash = lens[i:j + 1]
            # i trattini in mezzo devono essere simili (gli estremi possono essere accorciati)
            inner = dash[1:-1] if len(dash) > 3 else dash
            if max(inner) <= 3.5 * max(min(inner), 0.05) + 0.1:
                segs = []
                for k in range(i, j + 1):
                    if segs:
                        segs.append(("L", _end(segs[-1]), pieces[k][0][0][1]))
                    segs += list(pieces[k][0])
                segs = _merge_collinear(segs, tol)
                if fit_arcs:
                    segs = _merge_arcs(_arcs_from_lines(segs, max(tol, 0.12)), tol)
                out.append((segs, False, _pattern(dash, gaps)))
                i = j + 1
                continue
        out.append((pieces[i][0], pieces[i][1], None))
        i += 1
    return out


def _box_of(subs):
    x0 = y0 = math.inf
    x1 = y1 = -math.inf
    for sub in subs:
        for sg in sub:
            b = pdfclip.bbox(sg)
            x0, y0, x1, y1 = min(x0, b[0]), min(y0, b[1]), max(x1, b[2]), max(y1, b[3])
    return (x0, y0, x1, y1)


def _apply_masks(order, masks):
    """I tratti disegnati PRIMA di un riempimento bianco perdono le parti che lui copre (come si vede nel PDF)."""
    if not masks:
        return
    cell = 64.0
    grid = {}
    for mi, (seq, rg) in enumerate(masks):
        x0, y0, x1, y1 = rg.rect
        for gx in range(int(x0 // cell), int(x1 // cell) + 1):
            for gy in range(int(y0 // cell), int(y1 // cell) + 1):
                grid.setdefault((gx, gy), []).append(mi)
    for idx, (kind, v) in enumerate(order):
        if kind != "s":
            continue
        x0, y0, x1, y1 = v["box"]
        if not math.isfinite(x0):
            continue
        cand = set()
        for gx in range(int(x0 // cell), int(x1 // cell) + 1):
            for gy in range(int(y0 // cell), int(y1 // cell) + 1):
                cand.update(grid.get((gx, gy), ()))
        hit = [masks[mi][1] for mi in sorted(cand) if masks[mi][0] > idx and not masks[mi][1].inside_box(v["box"])]
        if not hit:
            continue
        out = []
        for pc, closed in v["pieces"]:
            res = pdfclip.apply([pc], hit)
            if len(res) == 1 and len(res[0]) == len(pc) and res[0][0][1] == pc[0][1] and res[0][-1] == pc[-1]:
                out.append((pc, closed))
            else:
                out += [(r, False) for r in res]
        v["pieces"] = out


SHX_TITLE = "AutoCAD SHX Text"
_DESC = set("gjpqy,;()[]{}_|$@Qµ")


def shx_annots(page):
    """Commenti "AutoCAD SHX Text": AutoCAD li aggiunge a ogni testo SHX che scrive come tratti. -> [(testo, A, B)] con A, B i
    due angoli del /Rect nell'ordine scritto (B = inizio della linea di base, A = angolo opposto), coordinate di get_drawings."""
    out = []
    doc = page.parent
    tm = page.transformation_matrix
    try:
        annots = list(page.annots())
    except Exception:  # noqa: BLE001
        return out
    for a in annots:
        try:
            if a.type[0] != pymupdf.PDF_ANNOT_SQUARE or (a.info.get("title") or "") != SHX_TITLE:
                continue
            txt = (a.info.get("content") or "").strip()
            raw = doc.xref_get_key(a.xref, "Rect")
            nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", raw[1])]
        except Exception:  # noqa: BLE001
            continue
        if not txt or len(nums) != 4:
            continue
        A = pymupdf.Point(nums[0], nums[1]) * tm
        B = pymupdf.Point(nums[2], nums[3]) * tm
        out.append((txt, (A.x, A.y), (B.x, B.y)))
    return out


def _text_from_boxes(txt, rot, boxes, col, layer):
    """TEXT ricostruito dai riquadri dei tratti delle lettere: linea di base, altezza delle maiuscole, larghezza misurata."""
    r = math.radians(rot)
    ux, uy = math.cos(r), math.sin(r)  # direzione della scritta
    vx, vy = -uy, ux  # verso l'alto della scritta
    us, vs = [], []
    for bb in boxes:
        for px, py in ((bb[0], bb[1]), (bb[2], bb[3]), (bb[0], bb[3]), (bb[2], bb[1])):
            us.append(px * ux + py * uy)
            vs.append(px * vx + py * vy)
    umin, umax, vmin, vmax = min(us), max(us), min(vs), max(vs)
    ext = vmax - vmin
    letters = [ch for ch in txt if not ch.isspace()]
    desc = any(ch in _DESC for ch in letters)
    upper = any(ch.isupper() or ch.isdigit() or ch in "bdfhklt" for ch in letters)
    if desc:
        cap = ext / 1.32
        base = vmax - cap
    elif not upper and letters and all(ch.islower() for ch in letters):
        cap = ext / 0.72  # solo lettere basse (a, c, e...): l'altezza misurata e' quella della x
        base = vmin
    elif letters and all(ch in "-_=~.,:;'\"`*+°" for ch in letters):
        return None
    else:
        cap = ext
        base = vmin
    if cap <= 0 or umax - umin <= 0:
        return None
    ff = font_file("Arial", False, False)
    size = cap / cap_ratio(ff)
    wf = 1.0
    try:
        exp = _mu_font(ff).text_length(txt, fontsize=size)
        if exp > 0:
            wf = max(0.3, min(3.0, round((umax - umin) / exp, 3)))
    except Exception:  # noqa: BLE001
        pass
    return {"t": "text", "p": [umin * ux + base * vx, umin * uy + base * vy], "h": cap, "rot": rot, "s": txt, "font": "Arial", "bold": False,
            "italic": False, "file": ff, "wf": wf, "col": col, "L": layer, "_u": (umin, umax)}


def _piece_pts(order, ri, pi):
    """Punti di un pezzo (estremi dei segmenti; vertici del contorno per le lettere piene)."""
    v = order[ri][1]
    if pi < 0:
        return [(q[0], q[1]) for q in v["paths"][-pi - 1]]
    pts = []
    for sg in v["pieces"][pi][0]:
        if sg[0] == "B":
            pts += [sg[1], sg[4]]
        elif sg[0] == "A":
            pts += [pdfclip.point(sg, k / 4) for k in range(5)]
        else:
            pts += [sg[1], sg[2]]
    return pts


def _best_angle(pts, lo, hi):
    """Angolo della linea di base: quello (tra lo e hi gradi) che rende minima l'altezza della scritta."""
    def ext(a):
        r = math.radians(a)
        vx, vy = -math.sin(r), math.cos(r)
        vs = [x * vx + y * vy for x, y in pts]
        return max(vs) - min(vs)
    best = min((ext(a), a) for a in [lo + (hi - lo) * k / 90 for k in range(91)])[1]
    step = (hi - lo) / 90
    for _ in range(3):
        best = min((ext(a), a) for a in [best + step * (k - 5) / 5 for k in range(11)])[1]
        step /= 5
    # i testi CAD sono quasi sempre a 0/90/180/270 gradi o ad angoli "tondi": si arrotonda se la differenza e' minima
    for snap in (round(best / 90) * 90, round(best)):
        if abs(snap - best) < 0.35 and ext(snap) <= ext(best) * 1.01 + 1e-6:
            return snap % 360
    return best % 360


def _shx_texts(page, T, order, layer_of, opts):
    """Testi SHX di AutoCAD (scritti come tratti): i tratti dentro il riquadro di ogni commento "AutoCAD SHX Text" diventano un
    TEXT (o un MTEXT se il testo va su piu' righe) con posizione, altezza, rotazione e larghezza misurate sui tratti.
    Il /Rect del commento ha prima l'angolo opposto e poi l'inizio della linea di base, anche per i testi inclinati."""
    ann = shx_annots(page)
    if not ann:
        return [], []
    cell = 24.0
    grid = _piece_grid(order, cell)
    taken = set()
    out = []
    rejected = []

    def frame(rot):
        r = math.radians(rot)
        return math.cos(r), math.sin(r), -math.sin(r), math.cos(r)

    def inside(h, fr, L, Hb, mu, mv):
        ux, uy, vx, vy = fr
        for qx, qy in pts_of[h]:
            du, dv = (qx - b[0]) * ux + (qy - b[1]) * uy, (qx - b[0]) * vx + (qy - b[1]) * vy
            if not (-mu <= du <= L + mu and -mv - 0.35 * Hb <= dv <= Hb + mv):
                return False
        return True

    def caps(keep, fr):
        ux, uy, vx, vy = fr
        ex = sorted(max(vs) - min(vs) for vs in ([(qx - b[0]) * vx + (qy - b[1]) * vy for qx, qy in pts_of[h]] for h in keep))
        return ex[int(len(ex) * 0.85)] if ex else 0.0
    for txt, A, B in ann:
        a, b = T(*A), T(*B)
        dx, dy = a[0] - b[0], a[1] - b[1]
        D = math.hypot(dx, dy)
        if D <= 0:
            continue
        m = max(0.6, 0.12 * min(abs(dx), abs(dy)) + 0.4)
        x0, y0, x1, y1 = min(a[0], b[0]) - m, min(a[1], b[1]) - m, max(a[0], b[0]) + m, max(a[1], b[1]) + m
        hits = []
        for gx in range(int(x0 // cell) - 1, int(x1 // cell) + 1):
            for gy in range(int(y0 // cell) - 1, int(y1 // cell) + 1):
                for ri, pi, bb in grid.get((gx, gy), ()):
                    if (ri, pi) not in taken and bb[0] >= x0 and bb[1] >= y0 and bb[2] <= x1 and bb[3] <= y1:
                        hits.append((ri, pi))
        if not hits:
            continue
        pts_of = {h: _piece_pts(order, *h) for h in hits}
        phi = math.degrees(math.atan2(dy, dx))
        lines_txt = [ln.strip() for ln in txt.replace("\r\n", "\n").replace("\r", "\n").split("\n") if ln.strip()]
        # 1) paragrafo su piu' righe: quasi sempre dritto (0/90/180/270 gradi)
        para = None
        for ax in (0, 90, 180, 270, 360, -90, -180):
            if phi - 90 - 1 <= ax <= phi + 1:
                fr = frame(ax)
                L, Hb = dx * fr[0] + dy * fr[1], dx * fr[2] + dy * fr[3]
                if L <= 0 or Hb <= 0:
                    continue
                keep = [h for h in hits if inside(h, fr, L, Hb, 0.6, 0.6)]
                cap = caps(keep, fr)
                if keep and cap > 0 and (Hb > 2.1 * cap or len(lines_txt) > 1):
                    para = (ax % 360, fr, keep, cap)
                    break
        if para:
            rot, fr, keep, cap = para
            rec = order[keep[0][0]][1]
            info = []
            for h in keep:
                vs = [(qx - b[0]) * fr[2] + (qy - b[1]) * fr[3] for qx, qy in pts_of[h]]
                us = [(qx - b[0]) * fr[0] + (qy - b[1]) * fr[1] for qx, qy in pts_of[h]]
                info.append((min(vs), max(vs), min(us), max(us), h))
            e = _shx_paragraph(lines_txt, info, cap, rot, fr, b, rec["attrs"].get("col"), layer_of(rec.get("ocg"), None, None, "text"))
            if e:
                out.append(e)
                taken.update(keep)
            else:
                rejected.append((x0, y0, x1, y1))
            continue
        # 2) una riga: angolo dalla diagonale del riquadro (lunghezza ~ 0,9 x altezza per carattere), poi affinato sui tratti
        n = max(1, len(txt.strip()))
        th0 = phi - math.degrees(math.atan2(1.0, 0.9 * n))
        fr = frame(th0)
        L, Hb = dx * fr[0] + dy * fr[1], dx * fr[2] + dy * fr[3]
        if L <= 0 or Hb <= 0:
            continue
        keep = [h for h in hits if inside(h, fr, L, Hb, 0.3 * Hb + 0.5, 0.5 * Hb + 0.5)]
        if not keep:
            continue
        win = min(40.0, max(7.0, 0.8 * (phi - th0)))  # testi corti: la stima dalla diagonale e' grossolana
        rot = _best_angle([q for h in keep for q in pts_of[h]], th0 - win, th0 + win)
        fr = frame(rot)
        L, Hb = dx * fr[0] + dy * fr[1], dx * fr[2] + dy * fr[3]
        keep = [h for h in hits if inside(h, fr, max(L, 0.1), max(Hb, 0.1), 0.15 * abs(Hb) + 0.5, 0.2 * abs(Hb) + 0.5)]
        if not keep:
            continue
        rec = order[keep[0][0]][1]
        boxes = [(q[0], q[1], q[0], q[1]) for h in keep for q in pts_of[h]]
        e = _text_from_boxes(txt.replace("\t", "    "), rot, boxes, rec["attrs"].get("col"), layer_of(rec.get("ocg"), None, None, "text"))
        if e:
            out.append(e)
            taken.update(keep)
    for ri, pi in taken:
        order[ri][1]["pieces"][pi] = None
    for kind, v in order:
        if kind == "s" and any(pc is None for pc in v["pieces"]):
            v["pieces"] = [pc for pc in v["pieces"] if pc is not None]
    return out, rejected


def _shx_paragraph(lines_txt, info, cap, rot, frame, b, col, lay):
    """Testo SHX su piu' righe -> MTEXT con le righe come nel PDF (a capo esplicito: l'a capo automatico di un altro carattere
    cambierebbe le righe)."""
    ux, uy, vx, vy = frame
    info = sorted(info, key=lambda i: -(i[0] + i[1]) / 2)
    rows = []
    for i in info:
        c = (i[0] + i[1]) / 2
        if rows and abs(rows[-1]["c"] - c) < 0.75 * cap:
            rw = rows[-1]
            rw["items"].append(i)
            rw["c"] = sum((j[0] + j[1]) / 2 for j in rw["items"]) / len(rw["items"])
        else:
            rows.append({"c": c, "items": [i]})
    rows = [rw for rw in rows if rw["items"]]
    if not rows:
        return None
    for rw in rows:
        rw["base"] = min(j[0] for j in rw["items"])
        rw["u0"] = min(j[2] for j in rw["items"])
        rw["u1"] = max(j[3] for j in rw["items"])
    # testo diviso sulle righe: se il commento ha gia' le righe giuste si usano, altrimenti le parole si distribuiscono
    # in proporzione alla lunghezza di ogni riga
    if len(lines_txt) == len(rows):
        parts = lines_txt
    else:
        words = " ".join(lines_txt).replace("\t", " ").split()
        tot = sum(rw["u1"] - rw["u0"] for rw in rows) or 1.0
        nchar = sum(len(w) + 1 for w in words)
        parts, k = [], 0
        for n, rw in enumerate(rows):
            if n == len(rows) - 1:
                got = words[k:]
                k = len(words)
            else:
                want = (rw["u1"] - rw["u0"]) / tot * nchar
                got, ln = [], 0
                while k < len(words) and (not got or ln + len(words[k]) / 2 <= want):
                    got.append(words[k])
                    ln += len(words[k]) + 1
                    k += 1
            parts.append(" ".join(got))
    try:
        ff0 = font_file("Arial", False, False)
        want = sum(rw["u1"] - rw["u0"] for rw in rows)
        got = sum(_mu_font(ff0).text_length(t, fontsize=cap / cap_ratio(ff0)) for t in parts)
        if not (0.55 <= got / max(want, 1e-6) <= 1.7):
            return None  # il testo del commento non corrisponde ai tratti: restano i tratti (o l'OCR)
    except Exception:  # noqa: BLE001
        pass
    spacing = None
    if len(rows) > 1:
        ds = sorted(rows[i]["base"] - rows[i + 1]["base"] for i in range(len(rows) - 1))
        spacing = ds[len(ds) // 2]
    u0 = min(rw["u0"] for rw in rows)
    top = rows[0]["base"] + cap
    p = (b[0] + u0 * ux + top * vx, b[1] + u0 * uy + top * vy)
    ff = font_file("Arial", False, False)
    wf = 1.0
    try:
        size = cap / cap_ratio(ff)
        r = [(rw["u1"] - rw["u0"]) / _mu_font(ff).text_length(t, fontsize=size) for rw, t in zip(rows, parts) if t]
        if r:
            wf = max(0.3, min(3.0, round(sorted(r)[len(r) // 2], 3)))
    except Exception:  # noqa: BLE001
        pass
    return {"t": "mtext", "p": list(p), "h": cap, "rot": rot, "lines": parts, "spacing": spacing, "font": "Arial", "bold": False,
            "italic": False, "file": ff, "wf": wf, "col": col, "L": lay}


def _piece_grid(order, cell, fills=False):
    grid = {}
    for ri, (kind, v) in enumerate(order):
        if kind == "s":
            for pi, pcc in enumerate(v["pieces"]):
                if pcc is None:
                    continue
                b = _box_of([pcc[0]])
                grid.setdefault((int(b[0] // cell), int(b[1] // cell)), []).append((ri, pi, b))
        elif fills and kind == "e" and v.get("t") == "hatch":
            for k, pth in enumerate(v["paths"]):
                b = _path_box(pth)
                grid.setdefault((int(b[0] // cell), int(b[1] // cell)), []).append((ri, -k - 1, b))
    return grid


def _shx_from_hidden(texts, order, layer_of, hidden_prefix):
    """Testi invisibili (modo 3) appoggiati sopra tratti che li disegnano: e' il testo SHX che AutoCAD conserva come testo
    nascosto. I tratti dentro il riquadro del testo si tolgono e il testo diventa visibile, misurato sui tratti."""
    hid = [e for e in texts if e["t"] == "text" and e["L"].startswith(hidden_prefix)]
    if not hid or not order:
        return texts, []
    cell = 24.0
    grid = _piece_grid(order, cell, fills=True)
    taken, out, used = set(), [], set()
    for idx, e in enumerate(texts):
        if e["t"] != "text" or not e["L"].startswith(hidden_prefix):
            continue
        h = e["h"]
        try:
            size = h / cap_ratio(e.get("file"))
            ln = _mu_font(e.get("file")).text_length(e["s"], fontsize=size) * (e.get("wf") or 1.0)
        except Exception:  # noqa: BLE001
            ln = len(e["s"]) * h * 0.8
        if ln <= 0 or h <= 0:
            continue
        r = math.radians(e["rot"])
        ux, uy, vx, vy = math.cos(r), math.sin(r), -math.sin(r), math.cos(r)
        px, py = e["p"]
        u0, u1, v0, v1 = -0.25 * h, ln + 0.25 * h, -0.45 * h, 1.45 * h
        cs = [(px + a * ux + b * vx, py + a * uy + b * vy) for a in (u0, u1) for b in (v0, v1)]
        X0, Y0 = min(c[0] for c in cs), min(c[1] for c in cs)
        X1, Y1 = max(c[0] for c in cs), max(c[1] for c in cs)
        hits = []
        for gx in range(int(X0 // cell) - 1, int(X1 // cell) + 1):
            for gy in range(int(Y0 // cell) - 1, int(Y1 // cell) + 1):
                for ri, pi, bb in grid.get((gx, gy), ()):
                    if (ri, pi) in taken or bb[0] < X0 or bb[1] < Y0 or bb[2] > X1 or bb[3] > Y1:
                        continue
                    ok = True
                    for qx, qy in ((bb[0], bb[1]), (bb[2], bb[3]), (bb[0], bb[3]), (bb[2], bb[1])):
                        du, dv = (qx - px) * ux + (qy - py) * uy, (qx - px) * vx + (qy - py) * vy
                        if not (u0 <= du <= u1 and v0 <= dv <= v1):
                            ok = False
                            break
                    if ok:
                        hits.append((ri, pi, bb))
        if len(hits) < max(1, len(e["s"].replace(" ", "")) * 0.3):
            continue
        rec = order[hits[0][0]][1]
        # riquadri dei tratti nel sistema della scritta: per i testi inclinati si usano i vertici veri, non i riquadri
        pts = []
        for ri, pi, bb in hits:
            if pi < 0:  # lettera piena (TrueType come geometria): vertici del contorno
                pts += [(v[0], v[1]) for v in order[ri][1]["paths"][-pi - 1]]
            else:
                for sg in order[ri][1]["pieces"][pi][0]:
                    pts += [sg[1], sg[-1] if sg[0] == "B" else sg[2]]
        boxes = [(q[0], q[1], q[0], q[1]) for q in pts]
        col = rec["attrs"].get("col") if hits[0][1] >= 0 else rec.get("col")
        ne = _text_from_boxes(e["s"], e["rot"], boxes, col, layer_of(rec.get("ocg"), None, None, "text"))
        if not ne:
            continue
        out.append(ne)
        used.add(idx)
        for ri, pi, _ in hits:
            taken.add((ri, pi))
    gone = {}
    for ri, pi in taken:
        if pi < 0:
            gone.setdefault(ri, set()).add(-pi - 1)
        else:
            order[ri][1]["pieces"][pi] = None
    for ri, ks in gone.items():  # lettere piene sostituite dal testo
        v = order[ri][1]
        v["paths"] = [pth for k, pth in enumerate(v["paths"]) if k not in ks]
        if not v["paths"]:
            order[ri] = ("x", v)
    for kind, v in order:
        if kind == "s" and any(pc is None for pc in v["pieces"]):
            v["pieces"] = [pc for pc in v["pieces"] if pc is not None]
    return [e for i, e in enumerate(texts) if i not in used], out


def _path_box(pth):
    xs = [v[0] for v in pth]
    ys = [v[1] for v in pth]
    return (min(xs), min(ys), max(xs), max(ys))


def _hatch_box(e):
    xs = [v[0] for pth in e["paths"] for v in pth]
    ys = [v[1] for pth in e["paths"] for v in pth]
    return (min(xs), min(ys), max(xs), max(ys))


def _drawn_texts(page, order, layer_of, opts, update=None, zones=None):
    """Testi scritti come disegno (SHX senza commenti, TrueType "come geometria"): la pagina si legge con l'OCR del sistema e
    i tratti/contorni che stanno dentro una parola letta diventano un TEXT. I tratti originali restano su un layer spento
    (nessuna perdita se l'OCR sbaglia una lettera)."""
    import numpy as np
    from . import rastervec
    W, H = page.rect.width, page.rect.height
    dpi = int(max(72, min(300, 9990 / (max(W, H) / 72))))
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False, annots=False)
    B = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width) < 160
    if update:
        update(message=tr("srv_drawing.riconoscimento_testi"))
    sc = 72 / dpi
    try:
        if zones:  # solo le zone indicate (ritagli dell'immagine: molto piu' veloce che leggere tutta la tavola)
            words = []
            for z in zones:
                c0, c1 = max(0, int(z[0] / sc) - 4), min(B.shape[1], int(z[2] / sc) + 5)
                r0, r1 = max(0, int((H - z[3]) / sc) - 4), min(B.shape[0], int((H - z[1]) / sc) + 5)
                if c1 - c0 < 8 or r1 - r0 < 8:
                    continue
                for w in rastervec.ocr_words(B[r0:r1, c0:c1]):
                    words.append((w[0], w[1] + c0, w[2] + r0, w[3] + c0, w[4] + r0) + tuple(w[5:]))
        else:
            words = rastervec.ocr_words(B)
    except Exception:  # noqa: BLE001
        return []
    if not words:
        return []
    cell = 24.0
    grid = {}
    for ri, (kind, v) in enumerate(order):
        if kind == "s":
            for pi, (pc, _) in enumerate(v["pieces"]):
                b = _box_of([pc])
                grid.setdefault((int(b[0] // cell), int(b[1] // cell)), []).append((ri, pi, b))
        elif kind == "e" and v.get("t") == "hatch":
            for k, pth in enumerate(v["paths"]):
                b = _path_box(pth)
                grid.setdefault((int(b[0] // cell), int(b[1] // cell)), []).append((ri, -k - 1, b))
    taken, out = set(), []
    hidden = layer_of(None, None, None, "drawn")
    moved = []
    for w in words:
        txt = w[0].strip().replace("�", "")
        if not txt or all(c in rastervec.JUNK for c in txt):
            continue
        rot = w[5]
        # riquadro della parola: pixel della pagina (y in basso) -> punti con y verso l'alto
        x0, y0, x1, y1 = w[1] * sc, H - w[4] * sc, w[3] * sc, H - w[2] * sc
        if zones and not any(z[0] <= (x0 + x1) / 2 <= z[2] and z[1] <= (y0 + y1) / 2 <= z[3] for z in zones):
            continue
        h = (y1 - y0) if rot == 0 else (x1 - x0)
        ln = (x1 - x0) if rot == 0 else (y1 - y0)
        if h <= 0.5 or ln <= 0.5:
            continue
        if len(txt) == 1 and txt in "oO0" and 0.75 < (x1 - x0) / max(y1 - y0, 1e-6) < 1.33:
            continue  # un cerchietto letto come lettera
        m = max(0.8, h * 0.18)
        X0, Y0, X1, Y1 = x0 - m, y0 - m, x1 + m, y1 + m
        hits = []
        for gx in range(int(X0 // cell) - 1, int(X1 // cell) + 1):
            for gy in range(int(Y0 // cell) - 1, int(Y1 // cell) + 1):
                for ri, pi, bb in grid.get((gx, gy), ()):
                    if (ri, pi) in taken:
                        continue
                    if bb[0] >= X0 and bb[1] >= Y0 and bb[2] <= X1 and bb[3] <= Y1 and max(bb[2] - bb[0], bb[3] - bb[1]) <= max(h * 1.6, ln):
                        hits.append((ri, pi, bb))
        letters = len(txt.replace(" ", ""))
        if not hits or len(hits) < max(1, letters * 0.3):
            continue
        ux0, uy0 = min(b[0] for *_, b in hits), min(b[1] for *_, b in hits)
        ux1, uy1 = max(b[2] for *_, b in hits), max(b[3] for *_, b in hits)
        cover = ((ux1 - ux0) / max(x1 - x0, 1e-6)) if rot == 0 else ((uy1 - uy0) / max(y1 - y0, 1e-6))
        if cover < 0.6:
            continue
        rec = order[hits[0][0]][1]
        col = rec["attrs"].get("col") if hits[0][1] >= 0 else rec.get("col")
        ocg = rec.get("ocg")
        e = _text_from_boxes(txt, rot, [b for *_, b in hits], col, layer_of(ocg, None, None, "text"))
        if not e or e["h"] > h * 1.15 or e["h"] < h * 0.3:
            continue
        if any(order[ri][1].get("bold") for ri, pi, _ in hits if pi < 0):
            e["bold"] = True
        out.append(e)
        for ri, pi, _ in hits:
            taken.add((ri, pi))
            moved.append((ri, pi))
    split = {}
    for ri, pi in moved:
        if pi < 0:
            split.setdefault(ri, set()).add(-pi - 1)
        else:
            v = order[ri][1]
            v.setdefault("_drawn", []).append(v["pieces"][pi])
            v["pieces"][pi] = None
    for ri, ks in split.items():  # contorni delle lettere: su un riempimento a parte sul layer spento
        v = order[ri][1]
        moved_p = [pth for k, pth in enumerate(v["paths"]) if k in ks]
        v["paths"] = [pth for k, pth in enumerate(v["paths"]) if k not in ks]
        if not v["paths"]:
            order[ri] = ("x", v)
        order.append(("e", {**v, "paths": moved_p, "L": hidden}))
    for i, (kind, v) in enumerate(list(order)):
        if kind == "s" and v.get("_drawn"):
            v["pieces"] = [pc for pc in v["pieces"] if pc is not None]
            order.append(("s", {"pieces": v.pop("_drawn"), "attrs": {**v["attrs"], "L": hidden}, "box": v["box"]}))
    return _join_words(out)


def _join_words(texts):
    """Parole vicine sulla stessa linea di base (stessa altezza e rotazione) -> un solo testo."""
    texts = sorted(texts, key=lambda e: (e["rot"], e["L"], round(_rot_y(e) / max(e["h"], 1e-6) * 2), _rot_x(e)))
    out = []
    for e in texts:
        if out:
            p = out[-1]
            if (p["rot"] == e["rot"] and p["L"] == e["L"] and p.get("col") == e.get("col") and abs(p["h"] - e["h"]) < 0.25 * p["h"]
                    and abs(_rot_y(p) - _rot_y(e)) < 0.3 * p["h"] and 0 <= e["_u"][0] - p["_u"][1] < 1.4 * p["h"]):
                u0, u1 = p["_u"][0], e["_u"][1]
                p["s"] = p["s"] + " " + e["s"]
                p["_u"] = (u0, u1)
                try:
                    exp = _mu_font(p["file"]).text_length(p["s"], fontsize=p["h"] / cap_ratio(p["file"]))
                    p["wf"] = max(0.3, min(3.0, round((u1 - u0) / exp, 3))) if exp > 0 else p["wf"]
                except Exception:  # noqa: BLE001
                    pass
                continue
        out.append(dict(e))
    return out


def _images(page, T, layer_of):
    """Immagini della pagina (foto, loghi, timbri) -> {"t": "image", data, ext, w, h, o, u, v}: o = angolo del pixel (0, 0) (in alto
    a sinistra), u = vettore lungo la prima riga di pixel, v = lungo la prima colonna, coordinate della pagina con y verso l'alto."""
    out = []
    doc = page.parent
    try:
        infos = page.get_image_info(xrefs=True)
    except Exception:  # noqa: BLE001
        return out
    blocks, inline = [], None
    for inf in infos:
        if inf.get("xref"):
            try:
                x = doc.extract_image(inf["xref"])  # flusso originale, senza decodificare la pagina
            except Exception:  # noqa: BLE001
                continue
            if not x or not x.get("image"):
                continue
            mask = None
            if x.get("smask"):
                try:
                    mask = doc.extract_image(x["smask"]).get("image")
                except Exception:  # noqa: BLE001
                    mask = None
            blocks.append({"type": 1, "image": x["image"], "ext": x.get("ext"), "width": x.get("width") or inf["width"],
                           "height": x.get("height") or inf["height"], "transform": inf["transform"], "mask": mask})
        else:  # immagine in linea: solo dal testo strutturato della pagina
            if inline is None:
                try:
                    inline = [bl for bl in page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_IMAGES)["blocks"] if bl.get("type") == 1]
                except Exception:  # noqa: BLE001
                    inline = []
            for bl in inline:
                if tuple(round(v, 2) for v in bl["transform"]) == tuple(round(v, 2) for v in inf["transform"]):
                    blocks.append(bl)
                    break
    W, H = page.rect.width, page.rect.height
    for b in blocks:
        if b.get("type") != 1 or not b.get("image") or not b.get("width") or not b.get("height"):
            continue
        m = pymupdf.Matrix(b["transform"])
        o0, u0, v0 = pymupdf.Point(0, 0) * m, pymupdf.Point(1, 0) * m, pymupdf.Point(0, 1) * m
        o, u1, v1 = T(o0.x, o0.y), T(u0.x, u0.y), T(v0.x, v0.y)
        xs = [o[0], u1[0], v1[0], u1[0] + v1[0] - o[0]]
        ys = [o[1], u1[1], v1[1], u1[1] + v1[1] - o[1]]
        if max(xs) < 0 or min(xs) > W or max(ys) < 0 or min(ys) > H or (max(xs) - min(xs)) * (max(ys) - min(ys)) < 1:
            continue
        data, ext = b["image"], (b.get("ext") or "png").lower()
        try:
            if ext not in ("png", "jpeg", "jpg") or b.get("mask"):
                pix = pymupdf.Pixmap(data)
                if pix.colorspace and pix.colorspace.n not in (1, 3):
                    pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                if b.get("mask"):
                    mk = pymupdf.Pixmap(b["mask"])
                    if mk.width == pix.width and mk.height == pix.height:
                        pix = pymupdf.Pixmap(pymupdf.Pixmap(pix, 0) if pix.alpha else pix, mk)
                data, ext = pix.tobytes("png"), "png"
        except Exception:  # noqa: BLE001
            continue
        out.append({"t": "image", "data": data, "ext": "jpg" if ext == "jpeg" else ext, "w": b["width"], "h": b["height"], "o": list(o),
                    "u": [u1[0] - o[0], u1[1] - o[1]], "v": [v1[0] - o[0], v1[1] - o[1]], "L": layer_of(None, None, None, "image")})
    return out


def _clip_region(d, T, tol):
    """Elemento "clip" di get_drawings(extended=True) -> pdfclip.Region (None = nessun ritaglio utile)."""
    subs = _subpaths(d.get("items") or [], T, tol)
    if subs:
        polys = [pdfclip.sample_sub(sub) for sub in subs]
        return pdfclip.Region(polys=polys, evenodd=bool(d.get("even_odd")))
    sc = d.get("scissor")
    if sc is None:
        return None
    a, b = T(sc[0], sc[1]), T(sc[2], sc[3])
    return pdfclip.Region(rect=(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])))


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
