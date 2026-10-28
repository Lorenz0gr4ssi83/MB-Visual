"""Tracciati di ritaglio dei PDF (viewport delle tavole, retini dentro un contorno, cartigli) applicati alla geometria.

Le tavole di Revit, Vectorworks, ArchiCAD e AutoCAD (finestre dei layout) disegnano molto di piu' di quello che si vede e
lo nascondono con un tracciato di ritaglio: senza applicarlo il DXF mostra le parti tagliate, i retini escono dai contorni.
Segmenti come in pdfvec._subpaths: ("L", p0, p1) / ("A", p0, p1, c, r, ccw, ampiezza) / ("B", p0, c1, c2, p1).
Una regione = rettangolo (ritaglio piu' comune: si usa Liang-Barsky) o poligoni (curve campionate) con regola pari-dispari
o di avvolgimento. I pezzi rimasti dentro restano dello stesso tipo (un arco tagliato resta un arco).
"""
import math


def _bez(s, t):
    p0, p1, p2, p3 = s[1], s[2], s[3], s[4]
    u = 1 - t
    a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
    return (a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1])


def _lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _bez_split(s, t0, t1):
    """Pezzo [t0, t1] di una Bezier cubica (de Casteljau due volte)."""
    def split(p, t):
        p0, p1, p2, p3 = p
        a, b, c = _lerp(p0, p1, t), _lerp(p1, p2, t), _lerp(p2, p3, t)
        d, e = _lerp(a, b, t), _lerp(b, c, t)
        f = _lerp(d, e, t)
        return (p0, a, d, f), (f, e, c, p3)
    p = (s[1], s[2], s[3], s[4])
    if t1 < 1:
        p = split(p, t1)[0]
    if t0 > 0:
        p = split(p, t0 / t1 if t1 > 0 else 0)[1]
    return ("B", *p)


def _arc_pt(s, t):
    _, p0, _, c, r, ccw, sw = s
    a0 = math.atan2(p0[1] - c[1], p0[0] - c[0])
    a = a0 + math.radians(sw) * t * (1 if ccw else -1)
    return (c[0] + r * math.cos(a), c[1] + r * math.sin(a))


def point(s, t):
    if s[0] == "L":
        return _lerp(s[1], s[2], t)
    if s[0] == "A":
        return _arc_pt(s, t)
    return _bez(s, t)


def piece(s, t0, t1):
    if t0 <= 1e-9 and t1 >= 1 - 1e-9:
        return s
    if s[0] == "L":
        return ("L", _lerp(s[1], s[2], t0), _lerp(s[1], s[2], t1))
    if s[0] == "A":
        return ("A", _arc_pt(s, t0), _arc_pt(s, t1), s[3], s[4], s[5], s[6] * (t1 - t0))
    return _bez_split(s, t0, t1)


def bbox(s):
    if s[0] == "L":
        xs, ys = (s[1][0], s[2][0]), (s[1][1], s[2][1])
    elif s[0] == "A":
        pts = [point(s, k / 8) for k in range(9)]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return (min(xs) - s[4] * 0.08, min(ys) - s[4] * 0.08, max(xs) + s[4] * 0.08, max(ys) + s[4] * 0.08)
    else:
        xs, ys = [p[0] for p in s[1:5]], [p[1] for p in s[1:5]]
    return (min(xs), min(ys), max(xs), max(ys))


class Region:
    """Zona visibile: rettangolo (x0, y0, x1, y1) oppure poligoni chiusi con la loro regola di riempimento."""

    def __init__(self, rect=None, polys=None, evenodd=False, margin=0.6):
        self.polys = [p for p in (polys or []) if len(p) >= 3]
        self.evenodd = evenodd
        if self.polys:
            xs = [q[0] for p in self.polys for q in p]
            ys = [q[1] for p in self.polys for q in p]
            self.rect = (min(xs), min(ys), max(xs), max(ys))
            if len(self.polys) == 1 and _is_rect(self.polys[0]):
                self.polys = []
        else:
            self.rect = rect
        # margine solo per "tutto dentro": un tratto appoggiato sul bordo del ritaglio resta intero (meta' spessore si vede),
        # mentre i tratti che lo attraversano si tagliano esattamente sul bordo
        self.keep = self.rect
        if not self.polys and self.rect is not None and margin:
            x0, y0, x1, y1 = self.rect
            self.keep = (x0 - margin, y0 - margin, x1 + margin, y1 + margin)
        self.edges = []
        for p in self.polys:
            n = len(p)
            for i in range(n):
                a, b = p[i], p[(i + 1) % n]
                if a != b:
                    self.edges.append((a, b, min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])))

    def hole(self):
        return Hole(self)

    @property
    def is_rect(self):
        return not self.polys

    def contains(self, p):
        x0, y0, x1, y1 = self.keep
        if not (x0 - 1e-6 <= p[0] <= x1 + 1e-6 and y0 - 1e-6 <= p[1] <= y1 + 1e-6):
            return False
        if self.is_rect:
            return True
        x, y = p
        wn, par = 0, False
        for a, b, *_ in self.edges:
            if (a[1] > y) != (b[1] > y):
                xi = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
                if xi > x:
                    par = not par
                    wn += 1 if b[1] > a[1] else -1
        return par if self.evenodd else wn != 0

    def inside_box(self, b):
        """Il riquadro b sta tutto nella zona (solo per i rettangoli; per i poligoni serve il calcolo dei tagli)."""
        x0, y0, x1, y1 = self.keep
        return self.is_rect and b[0] >= x0 - 1e-6 and b[1] >= y0 - 1e-6 and b[2] <= x1 + 1e-6 and b[3] <= y1 + 1e-6

    def outside_box(self, b):
        x0, y0, x1, y1 = self.rect
        return b[2] < x0 or b[0] > x1 or b[3] < y0 or b[1] > y1

    def _cuts(self, a, b):
        """Parametri (0..1) in cui il segmento a-b attraversa il bordo della zona."""
        out = []
        if self.is_rect:
            x0, y0, x1, y1 = self.rect
            dx, dy = b[0] - a[0], b[1] - a[1]
            for v, d, lo in ((a[0], dx, x0), (a[0], dx, x1), (a[1], dy, y0), (a[1], dy, y1)):
                if abs(d) > 1e-12:
                    t = (lo - v) / d
                    if 0 < t < 1:
                        out.append(t)
            return out
        bx0, by0, bx1, by1 = min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])
        rx, ry = b[0] - a[0], b[1] - a[1]
        for p, q, ex0, ey0, ex1, ey1 in self.edges:
            if ex1 < bx0 or ex0 > bx1 or ey1 < by0 or ey0 > by1:
                continue
            sx, sy = q[0] - p[0], q[1] - p[1]
            den = rx * sy - ry * sx
            if abs(den) < 1e-14:
                continue
            t = ((p[0] - a[0]) * sy - (p[1] - a[1]) * sx) / den
            u = ((p[0] - a[0]) * ry - (p[1] - a[1]) * rx) / den
            if 0 < t < 1 and -1e-9 <= u <= 1 + 1e-9:
                out.append(t)
        return out

    def clip_seg(self, s):
        """Pezzi del segmento dentro la zona."""
        b = bbox(s)
        if self.outside_box(b):
            return []
        if self.inside_box(b):
            return [s]
        n = 1 if s[0] == "L" else (max(6, min(48, int(s[6] / 7.5))) if s[0] == "A" else 16)
        ts = [0.0, 1.0]
        prev = point(s, 0.0)
        for k in range(1, n + 1):
            t1 = k / n
            cur = point(s, t1)
            for c in self._cuts(prev, cur):
                ts.append((k - 1 + c) / n)
            prev = cur
        ts = sorted(set(round(t, 9) for t in ts))
        out = []
        for t0, t1 in zip(ts, ts[1:]):
            if t1 - t0 < 1e-7:
                continue
            if self.contains(point(s, (t0 + t1) / 2)):
                if out and abs(out[-1][1] - t0) < 1e-9:
                    out[-1] = (out[-1][0], t1)
                else:
                    out.append((t0, t1))
        return [piece(s, a, c) for a, c in out]

    def clip_sub(self, sub):
        """Sottotracciato -> sottotracciati (un taglio interrompe la continuita')."""
        res, cur, last = [], [], None
        for s in sub:
            for p in self.clip_seg(s):
                st = p[1]
                if cur and last is not None and (abs(st[0] - last[0]) > 1e-6 or abs(st[1] - last[1]) > 1e-6):
                    res.append(cur)
                    cur = []
                cur.append(p)
                last = p[4] if p[0] == "B" else p[2]
        if cur:
            res.append(cur)
        # un tracciato chiuso tagliato in due punti: l'ultimo pezzo continua nel primo
        if len(res) > 1:
            a, z = res[0], res[-1]
            za = z[-1][4] if z[-1][0] == "B" else z[-1][2]
            if abs(za[0] - a[0][1][0]) < 1e-6 and abs(za[1] - a[0][1][1]) < 1e-6 and _end_of(sub) == sub[0][1]:
                res[0] = z + a
                res.pop()
        return res

    def clip_poly(self, pts):
        """Poligono di un riempimento ritagliato (Sutherland-Hodgman sul rettangolo; poligoni: si tiene se il centro e' dentro)."""
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        b = (min(xs), min(ys), max(xs), max(ys))
        if self.outside_box(b):
            return None
        if self.inside_box(b):
            return pts
        if not self.is_rect:
            return pts if self.contains(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) or any(self.contains(p) for p in pts) else None
        x0, y0, x1, y1 = self.rect
        poly = [(p[0], p[1]) for p in pts]
        for inside, inter in (
                (lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
                (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
                (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
                (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1))):
            if not poly:
                return None
            out = []
            for i, cur in enumerate(poly):
                prev = poly[i - 1]
                if inside(cur):
                    if not inside(prev):
                        out.append(inter(prev, cur))
                    out.append(cur)
                elif inside(prev):
                    out.append(inter(prev, cur))
            poly = out
        return poly if len(poly) >= 3 else None


class Hole(Region):
    """Zona da togliere (riempimento bianco sopra il disegno): si tiene cio' che sta FUORI."""

    def __init__(self, base):  # noqa: D107 (stessi dati della zona di partenza)
        self.__dict__.update(base.__dict__)

    def contains(self, p):
        return not Region.contains(self, p)

    def inside_box(self, b):  # tutto da tenere: non tocca il rettangolo della mascheratura
        return Region.outside_box(self, b)

    def outside_box(self, b):  # tutto da togliere: dentro un rettangolo pieno
        return Region.inside_box(self, b)

    def clip_poly(self, pts):
        return pts


def _end_of(sub):
    s = sub[-1]
    return s[4] if s[0] == "B" else s[2]


def _is_rect(p):
    q = list(p)
    if len(q) == 5 and abs(q[0][0] - q[-1][0]) < 1e-6 and abs(q[0][1] - q[-1][1]) < 1e-6:
        q = q[:4]
    if len(q) != 4:
        return False
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        if abs(a[0] - b[0]) > 1e-4 and abs(a[1] - b[1]) > 1e-4:
            return False
    return True


def sample_sub(sub, step_deg=10):
    """Sottotracciato -> punti del contorno (curve campionate)."""
    pts = []
    for s in sub:
        if s[0] == "L":
            pts.append(s[1])
        else:
            n = max(4, int(s[6] / step_deg)) if s[0] == "A" else 12
            pts += [point(s, k / n) for k in range(n)]
    if sub:
        e = _end_of(sub)
        if abs(e[0] - pts[0][0]) > 1e-6 or abs(e[1] - pts[0][1]) > 1e-6:
            pts.append(e)
    return pts


class Stack:
    """Ritagli attivi secondo il livello di annidamento di get_drawings(extended=True)."""

    def __init__(self):
        self.items = []  # (livello, Region)

    def at(self, level):
        while self.items and self.items[-1][0] >= level:
            self.items.pop()
        return [r for _, r in self.items]

    def push(self, level, region):
        self.at(level)
        self.items.append((level, region))


def apply(subs, regions):
    for rg in regions:
        out = []
        for sub in subs:
            out += rg.clip_sub(sub)
        subs = out
        if not subs:
            break
    return subs
