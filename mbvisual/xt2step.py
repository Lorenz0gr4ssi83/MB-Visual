"""Conversione di un modello Parasolid (mbvisual.parasolid) in STEP AP214 (ISO 10303-21), scritta da zero.

Geometria esatta: piani, cilindri, coni, sfere, tori, superfici e curve B-spline/NURBS, superfici offset, estruse e di
rivoluzione, rette, cerchi, ellissi. Approssimate per campionamento (polilinee fitte): curve d'intersezione (dai punti
della "chart"), SP-curve (curve nello spazio parametrico di una superficie, spigoli tolleranti), raccordi a palla
(BLENDED_EDGE, ricostruiti come NURBS dai punti di contatto). Cio' che non si converte si salta e si conta nel resoconto.
Unita': Parasolid lavora in metri, lo STEP si scrive in millimetri.
"""
import math
from collections import Counter, defaultdict

from . import parasolid as P
from .i18n import t as tr

SCALE = 1000.0  # metri -> millimetri

# ---------------------------------------------------------------- vettori
def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def mul(a, k): return (a[0] * k, a[1] * k, a[2] * k)
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def norm(a): return math.sqrt(dot(a, a))


def unit(a):
    n = norm(a)
    return (a[0] / n, a[1] / n, a[2] / n) if n > 1e-300 else (0.0, 0.0, 1.0)


def perp(a):
    """Un vettore unitario perpendicolare ad a."""
    t = (1.0, 0.0, 0.0) if abs(a[0]) < 0.9 else (0.0, 1.0, 0.0)
    return unit(cross(a, t))


class Unsupported(Exception):
    """Geometria non convertibile. Il messaggio e' un codice (es. "surface:PE_SURF", "blend_E") che l'interfaccia traduce."""


# ---------------------------------------------------------------- NURBS
class Nurbs:
    """B-spline (curva o superficie) con nodi espansi, poli cartesiani e pesi."""

    def __init__(self, degree, knots, mults, poles, weights, dim):
        self.degree = degree
        self.knots = knots          # distinti
        self.mults = mults
        self.poles = poles          # lista di tuple (dim) gia' divise per il peso
        self.weights = weights      # None se non razionale
        self.dim = dim
        flat = []
        for k, m in zip(knots, mults):
            flat.extend([k] * m)
        self.flat = flat

    @property
    def range(self):
        p = self.degree
        return self.flat[p], self.flat[len(self.flat) - p - 1]


def _knot_data(xt, mult_idx, knot_idx, count):
    """Nodi distinti e molteplicita' (i vettori possono essere piu' lunghi del numero dichiarato di nodi)."""
    km = xt.node(mult_idx)
    ks = xt.node(knot_idx)
    if km is None or ks is None:
        raise Unsupported("bspline")
    knots = (ks.get("knots") or [])[:count]
    mults = (km.get("mult") or [])[:count]
    if len(knots) < count or len(mults) < count or any(k is None for k in knots):
        raise Unsupported("bspline")
    return [float(k) for k in knots], [int(m) for m in mults]


def _fix_knots(degree, knots, mults, npoles, periodic, poles, weights):
    """Rende i nodi coerenti con il numero di poli (sum(mult) = npoles + degree + 1). Nelle B-spline periodiche
    Parasolid puo' memorizzare solo i poli distinti: si "srotolano" ripetendo i primi 'degree' poli in coda."""
    total = sum(mults)
    if total == npoles + degree + 1:
        return knots, mults, poles, weights
    if periodic:
        # forma periodica: npoles poli distinti, nodi su un periodo (molteplicita' di testa = di coda)
        flat = []
        for k, m in zip(knots, mults):
            flat.extend([k] * m)
        period = flat[-1] - flat[0]
        if period <= 0:
            raise Unsupported("bspline")
        # nodi periodici: si estendono di 'degree' a sinistra e a destra
        base = flat[:]
        if mults[0] + 0 == mults[-1]:
            base = flat[:len(flat) - mults[-1]]  # un periodo esatto di nodi
        n_base = len(base)
        need = npoles + 2 * degree + 1
        ext = []
        i = -degree
        while len(ext) < need:
            q, r = divmod(i, n_base)
            ext.append(base[r] + q * period)
            i += 1
        poles = list(poles) + list(poles[:degree])
        if weights is not None:
            weights = list(weights) + list(weights[:degree])
        # di nuovo in forma distinti + molteplicita'
        kk, mm = [], []
        for k in ext:
            if kk and abs(k - kk[-1]) < 1e-14 * max(1.0, abs(k)):
                mm[-1] += 1
            else:
                kk.append(k)
                mm.append(1)
        if sum(mm) == len(poles) + degree + 1:
            return kk, mm, poles, weights
    raise Unsupported("bspline")


def nurbs_curve(xt, node):
    """Da B_CURVE (o NURBS_CURVE) a Nurbs. Funziona anche per le curve 2D delle SP-curve."""
    nc = xt.node(node.get("nurbs")) if node.type == 134 else node
    if nc is None:
        raise Unsupported("bspline")
    deg = nc.get("degree")
    n = nc.get("n_vertices")
    vd = nc.get("vertex_dim")
    rational = bool(nc.get("rational"))
    verts = xt.node(nc.get("bspline_vertices")).get("vertices", [])
    knots, mults = _knot_data(xt, nc.get("knot_mult"), nc.get("knots"), nc.get("n_knots"))
    dim = vd - 1 if rational else vd
    poles, weights = [], ([] if rational else None)
    for i in range(n):
        v = verts[i * vd:(i + 1) * vd]
        if rational:
            w = v[-1] or 1.0
            poles.append(tuple(c / w for c in v[:-1]))
            weights.append(w)
        else:
            poles.append(tuple(v))
    knots, mults, poles, weights = _fix_knots(deg, knots, mults, n, nc.get("periodic"), poles, weights)
    return Nurbs(deg, knots, mults, poles, weights, dim)


class NurbsSurf:
    def __init__(self, ud, vd, uk, um, vk, vm, poles, weights):
        self.u = Nurbs(ud, uk, um, [], None, 0)
        self.v = Nurbs(vd, vk, vm, [], None, 0)
        self.poles = poles      # [iu][iv] -> (x,y,z)
        self.weights = weights  # [iu][iv] o None


# ordine dei poli nelle B-superfici Parasolid: verificato sui file di prova (vedi tests/test_solidcad.py)
SURF_V_FASTEST = True


def nurbs_surface(xt, node):
    ns = xt.node(node.get("nurbs"))
    if ns is None:
        raise Unsupported("bspline")
    ud, vd_ = ns.get("u_degree"), ns.get("v_degree")
    nu, nv = ns.get("n_u_vertices"), ns.get("n_v_vertices")
    dim = ns.get("vertex_dim")
    rational = bool(ns.get("rational"))
    verts = xt.node(ns.get("bspline_vertices")).get("vertices", [])
    uk, um = _knot_data(xt, ns.get("u_knot_mult"), ns.get("u_knots"), ns.get("n_u_knots"))
    vk, vm = _knot_data(xt, ns.get("v_knot_mult"), ns.get("v_knots"), ns.get("n_v_knots"))
    grid = [[None] * nv for _ in range(nu)]
    wgrid = [[1.0] * nv for _ in range(nu)] if rational else None
    for iu in range(nu):
        for iv in range(nv):
            k = (iu * nv + iv) if SURF_V_FASTEST else (iv * nu + iu)
            v = verts[k * dim:(k + 1) * dim]
            if rational:
                w = v[-1] or 1.0
                grid[iu][iv] = (v[0] / w, v[1] / w, v[2] / w)
                wgrid[iu][iv] = w
            else:
                grid[iu][iv] = (v[0], v[1], v[2])
    # periodicita': si srotolano le righe/colonne se i nodi non tornano
    if sum(um) != nu + ud + 1:
        rows = list(range(nu))
        uk, um, rows, _ = _fix_knots(ud, uk, um, nu, ns.get("u_periodic"), rows, None)
        grid = [grid[i] for i in rows]
        if wgrid:
            wgrid = [wgrid[i] for i in rows]
    if sum(vm) != nv + vd_ + 1:
        cols = list(range(nv))
        vk, vm, cols, _ = _fix_knots(vd_, vk, vm, nv, ns.get("v_periodic"), cols, None)
        grid = [[row[j] for j in cols] for row in grid]
        if wgrid:
            wgrid = [[row[j] for j in cols] for row in wgrid]
    return NurbsSurf(ud, vd_, uk, um, vk, vm, grid, wgrid)


def _span(flat, p, t):
    n = len(flat) - p - 2
    lo, hi = p, n
    if t >= flat[n + 1]:
        return n
    if t <= flat[p]:
        return p
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if flat[mid] <= t:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _basis(flat, p, t, i):
    N = [1.0] + [0.0] * p
    left = [0.0] * (p + 1)
    right = [0.0] * (p + 1)
    for j in range(1, p + 1):
        left[j] = t - flat[i + 1 - j]
        right[j] = flat[i + j] - t
        saved = 0.0
        for r in range(j):
            den = right[r + 1] + left[j - r]
            tmp = N[r] / den if den else 0.0
            N[r] = saved + right[r + 1] * tmp
            saved = left[j - r] * tmp
        N[j] = saved
    return N


def eval_nurbs_curve(nb: Nurbs, t):
    p = nb.degree
    i = _span(nb.flat, p, t)
    N = _basis(nb.flat, p, t, i)
    acc = [0.0] * nb.dim
    wsum = 0.0
    for j in range(p + 1):
        k = i - p + j
        w = nb.weights[k] if nb.weights else 1.0
        c = N[j] * w
        P_ = nb.poles[k]
        for d in range(nb.dim):
            acc[d] += c * P_[d]
        wsum += c
    return tuple(a / wsum for a in acc) if wsum else tuple(acc)


def eval_nurbs_surf(ns: NurbsSurf, u, v):
    pu, pv = ns.u.degree, ns.v.degree
    iu = _span(ns.u.flat, pu, u)
    iv = _span(ns.v.flat, pv, v)
    Nu = _basis(ns.u.flat, pu, u, iu)
    Nv = _basis(ns.v.flat, pv, v, iv)
    x = y = z = wsum = 0.0
    for a in range(pu + 1):
        row = ns.poles[iu - pu + a]
        wrow = ns.weights[iu - pu + a] if ns.weights else None
        for b in range(pv + 1):
            w = wrow[iv - pv + b] if wrow else 1.0
            c = Nu[a] * Nv[b] * w
            q = row[iv - pv + b]
            x += c * q[0]
            y += c * q[1]
            z += c * q[2]
            wsum += c
    return (x / wsum, y / wsum, z / wsum)


# ---------------------------------------------------------------- valutazione di superfici e curve (in metri)
class Geo:
    def __init__(self, xt):
        self.xt = xt
        self._ns = {}
        self._nc = {}
        self.blend_builder = None  # impostato dal convertitore: NURBS dei raccordi a palla

    def nsurf(self, s):
        if s.index not in self._ns:
            self._ns[s.index] = nurbs_surface(self.xt, s)
        return self._ns[s.index]

    def ncurve(self, c):
        if c.index not in self._nc:
            self._nc[c.index] = nurbs_curve(self.xt, c)
        return self._nc[c.index]

    def surf_point(self, s, u, v, depth=0):
        t = s.type
        if depth > 8:
            raise Unsupported("geometry")
        if t == 50:
            n, x = unit(s["normal"]), unit(s["x_axis"])
            y = cross(n, x)
            return add(s["pvec"], add(mul(x, u), mul(y, v)))
        if t == 51:
            a, x = unit(s["axis"]), unit(s["x_axis"])
            y = cross(a, x)
            r = s["radius"]
            return add(s["pvec"], add(mul(x, r * math.cos(u)), add(mul(y, r * math.sin(u)), mul(a, v))))
        if t == 52:
            a, x = unit(s["axis"]), unit(s["x_axis"])
            y = cross(a, x)
            tan = s["sin_half_angle"] / s["cos_half_angle"]
            rr = s["radius"] + v * tan
            return add(sub(s["pvec"], mul(a, v)), add(mul(x, rr * math.cos(u)), mul(y, rr * math.sin(u))))
        if t == 53:
            a, x = unit(s["axis"]), unit(s["x_axis"])
            y = cross(a, x)
            r = s["radius"]
            return add(s["centre"], add(mul(add(mul(x, math.cos(u)), mul(y, math.sin(u))), r * math.cos(v)), mul(a, r * math.sin(v))))
        if t == 54:
            a, x = unit(s["axis"]), unit(s["x_axis"])
            y = cross(a, x)
            R, r = s["major_radius"], s["minor_radius"]
            return add(s["centre"], add(mul(add(mul(x, math.cos(u)), mul(y, math.sin(u))), R + r * math.cos(v)), mul(a, r * math.sin(v))))
        if t == 124:
            return eval_nurbs_surf(self.nsurf(s), u, v)
        if t == 56 and self.blend_builder is not None:
            return eval_nurbs_surf(self.blend_builder(s), u, v)
        if t == 60:
            b = self.xt.node(s["surface"])
            p = self.surf_point(b, u, v, depth + 1)
            n = self.surf_normal(b, u, v, depth + 1)
            d = s["offset"] * (1 if b["sense"] != "-" else -1)
            return add(p, mul(n, d))
        if t == 67:
            c = self.xt.node(s["section"])
            return add(self.curve_point(c, u), mul(unit(s["sweep"]), v))
        if t == 68:
            c = self.xt.node(s["profile"])
            q = self.curve_point(c, u)
            a = unit(s["axis"])
            base = s["base"]
            z = add(base, mul(a, dot(sub(q, base), a)))
            d = sub(q, z)
            return add(z, add(mul(d, math.cos(v)), mul(cross(a, d), math.sin(v))))
        raise Unsupported("surface:" + P.TYPE_NAMES.get(t, str(t)))

    def surf_normal(self, s, u, v, depth=0):
        """Normale naturale unitaria (dP/du x dP/dv) per differenze finite: basta per offset e raccordi."""
        h = 1e-6
        p0 = self.surf_point(s, u, v, depth)
        pu = sub(self.surf_point(s, u + h, v, depth), p0)
        pv = sub(self.surf_point(s, u, v + h, depth), p0)
        n = cross(pu, pv)
        if norm(n) < 1e-24:
            pu = sub(p0, self.surf_point(s, u - h, v, depth))
            pv = sub(p0, self.surf_point(s, u, v - h, depth))
            n = cross(pu, pv)
        return unit(n)

    def curve_point(self, c, t):
        ty = c.type
        if ty == 30:
            return add(c["pvec"], mul(unit(c["direction"]), t))
        if ty == 31:
            n, x = unit(c["normal"]), unit(c["x_axis"])
            y = cross(n, x)
            r = c["radius"]
            return add(c["centre"], add(mul(x, r * math.cos(t)), mul(y, r * math.sin(t))))
        if ty == 32:
            n, x = unit(c["normal"]), unit(c["x_axis"])
            y = cross(n, x)
            return add(c["centre"], add(mul(x, c["major_radius"] * math.cos(t)), mul(y, c["minor_radius"] * math.sin(t))))
        if ty == 134:
            return eval_nurbs_curve(self.ncurve(c), t)
        if ty == 133:
            return self.curve_point(self.xt.node(c["basis_curve"]), t)
        if ty == 137:
            s = self.xt.node(c["surface"])
            uv = eval_nurbs_curve(self.ncurve(self.xt.node(c["b_curve"])), t)
            return self.surf_point(s, uv[0], uv[1])
        raise Unsupported("curve:" + P.TYPE_NAMES.get(ty, str(ty)))

    def curve_range(self, c):
        ty = c.type
        if ty in (31, 32):
            return 0.0, 2 * math.pi
        if ty == 134:
            return self.ncurve(c).range
        if ty == 137:
            return self.ncurve(self.xt.node(c["b_curve"])).range
        if ty == 133:
            return c["parm_1"], c["parm_2"]
        if ty == 30:
            return -1.0, 1.0
        raise Unsupported("curve:" + P.TYPE_NAMES.get(ty, str(ty)))

    def chart_points(self, c):
        """Punti di una curva d'intersezione: limiti + punti della chart, in ordine di parametro."""
        ch = self.xt.node(c["chart"])
        if ch is None:
            raise Unsupported("intersection")
        pts = [h for h in ch.get("hvec", []) if h]
        for lim_idx, at_start in ((c["start"], True), (c["end"], False)):
            lim = self.xt.node(lim_idx)
            if lim is None or not lim.get("hvec"):
                continue
            h0 = lim["hvec"][0]
            if not h0:
                continue
            if lim.get("type") == "H":
                continue  # punto d'aiuto su una curva chiusa: e' gia' nella chart
            ref = pts[0] if at_start else pts[-1]
            if norm(sub(h0, ref)) > 1e-9:
                if at_start:
                    pts.insert(0, h0)
                else:
                    pts.append(h0)
        if len(pts) < 2:
            raise Unsupported("intersection")
        return pts

    def chart_params(self, c):
        """Punti della chart con i parametri della curva (lunghezza delle corde x base_scale: le correzioni
        angolari della specifica valgono circa 1 sulle chart fitte)."""
        pts = self.chart_points(c)
        ch = self.xt.node(c["chart"])
        t = ch.get("base_parameter") or 0.0
        sc = ch.get("base_scale") or 1.0
        first = (ch.get("hvec") or [None])[0]
        params = [0.0]
        for a, b in zip(pts, pts[1:]):
            params.append(params[-1] + norm(sub(b, a)) * sc)
        # il parametro base e' quello del primo punto della chart (prima ci puo' essere il limite iniziale)
        off = 0.0
        if first is not None:
            for p_, q in zip(pts, params):
                if norm(sub(p_, first)) < 1e-12:
                    off = q
                    break
        return pts, [t + q - off for q in params]

    def sample_curve(self, c, t0, t1, n):
        return [self.curve_point(c, t0 + (t1 - t0) * k / n) for k in range(n + 1)]


# ---------------------------------------------------------------- scrittura STEP
def _num(v):
    if v == 0:
        return "0."
    s = repr(float(v))
    if "e" in s or "E" in s:
        m, e = s.lower().split("e")
        if "." not in m:
            m += "."
        return f"{m}E{int(e)}"
    if "." not in s:
        s += "."
    return s


def _str(s):
    s = (s or "").replace("'", "''")
    # caratteri non ASCII: codifica \X2\ ... \X0\ (UTF-16) dello standard ISO 10303-21
    if all(32 <= ord(ch) < 127 for ch in s):
        return f"'{s}'"
    out = []
    for ch in s:
        if 32 <= ord(ch) < 127 and ch != "\\":
            out.append(ch)
        elif ch == "\\":
            out.append("\\\\")
        else:
            out.append("\\X2\\%04X\\X0\\" % (ord(ch) & 0xFFFF))
    return "'" + "".join(out) + "'"


class StepWriter:
    def __init__(self):
        self.lines = []
        self.n = 0
        self._cache = {}

    def add(self, text):
        self.n += 1
        self.lines.append(f"#{self.n}={text};")
        return f"#{self.n}"

    def once(self, key, text):
        r = self._cache.get(key)
        if r is None:
            r = self._cache[key] = self.add(text)
        return r

    def point(self, p, scale=SCALE):
        return self.add(f"CARTESIAN_POINT('',({_num(p[0] * scale)},{_num(p[1] * scale)},{_num(p[2] * scale)}))")

    def point2(self, p):
        return self.add(f"CARTESIAN_POINT('',({_num(p[0])},{_num(p[1])}))")

    def direction(self, d):
        d = unit(d)
        return self.once(("dir", round(d[0], 15), round(d[1], 15), round(d[2], 15)), f"DIRECTION('',({_num(d[0])},{_num(d[1])},{_num(d[2])}))")

    def axis2(self, p, z, x):
        z = unit(z)
        x = unit(sub(x, mul(z, dot(x, z))))  # x ortogonale a z
        if norm(x) < 0.5:
            x = perp(z)
        return self.add(f"AXIS2_PLACEMENT_3D('',{self.point(p)},{self.direction(z)},{self.direction(x)})")

    def text(self):
        return "\n".join(self.lines)


class Converter:
    """Trasforma i corpi di un file XT in entita' STEP. Un'istanza per file; scrive in uno StepWriter."""

    def __init__(self, xt, w: StepWriter, report: Counter):
        self.xt = xt
        self.w = w
        self.geo = Geo(xt)
        self.rep = report
        self.surf_ref = {}   # indice superficie -> (ref, flip)
        self.curve_ref = {}  # chiave -> ref
        self.vert_ref = {}
        self.edge_ref = {}
        self._curve_pts = {}
        self._building = set()
        self._all_pts = None
        self.geo.blend_builder = self.blend_nurbs

    # ---------- superfici: ritorna (riferimento STEP, flip) dove flip = normale naturale STEP opposta a Parasolid
    def surface(self, s):
        if s.index in self.surf_ref:
            return self.surf_ref[s.index]
        r = self._surface(s)
        self.surf_ref[s.index] = r
        return r

    def _surface(self, s):
        w, t = self.w, s.type
        if t == 50:
            return w.add(f"PLANE('',{w.axis2(s['pvec'], s['normal'], s['x_axis'])})"), False
        if t == 51:
            return w.add(f"CYLINDRICAL_SURFACE('',{w.axis2(s['pvec'], s['axis'], s['x_axis'])},{_num(s['radius'] * SCALE)})"), False
        if t == 52:
            sn, cs = s["sin_half_angle"], s["cos_half_angle"]
            ang = math.atan2(sn, cs)
            a = unit(s["axis"])
            p, r = s["pvec"], s["radius"]
            if r < 0:  # si porta il punto di riferimento sull'apice
                p = sub(p, mul(a, -r / math.tan(ang)))
                r = 0.0
            # asse STEP opposto a quello Parasolid (il cono Parasolid si apre verso -asse): verso u invertito
            return w.add(f"CONICAL_SURFACE('',{w.axis2(p, mul(a, -1), s['x_axis'])},{_num(r * SCALE)},{_num(ang)})"), True
        if t == 53:
            return w.add(f"SPHERICAL_SURFACE('',{w.axis2(s['centre'], s['axis'], s['x_axis'])},{_num(s['radius'] * SCALE)})"), False
        if t == 54:
            R, r = s["major_radius"], s["minor_radius"]
            ax = w.axis2(s["centre"], s["axis"], s["x_axis"])
            if R > r:
                return w.add(f"TOROIDAL_SURFACE('',{ax},{_num(R * SCALE)},{_num(r * SCALE)})"), False
            self.rep["degenerate_torus"] += 1
            return w.add(f"DEGENERATE_TOROIDAL_SURFACE('',{ax},{_num(abs(R) * SCALE)},{_num(r * SCALE)},{'.T.' if R > 0 else '.F.'})"), False
        if t == 124:
            return self._bsurface(self.geo.nsurf(s)), False
        if t == 60:
            b = self.xt.node(s["surface"])
            bref, bflip = self.surface(b)
            d = s["offset"] * (1 if b["sense"] != "-" else -1) * (-1 if bflip else 1)
            return w.add(f"OFFSET_SURFACE('',{bref},{_num(d * SCALE)},.F.)"), bflip
        if t == 67:
            sec = self.xt.node(s["section"])
            if sec is not None and sec.type == 134:
                # sezione B-spline: superficie B-spline esatta e limitata (sezione x segmento lungo la direzione), piu'
                # robusta in OpenCascade della SURFACE_OF_LINEAR_EXTRUSION infinita (che bloccava la triangolazione)
                return self._bsurface(self._swept_nurbs(s, self.geo.ncurve(sec))), False
            c = self.curve_geom(sec)
            vec = w.add(f"VECTOR('',{w.direction(s['sweep'])},1.)")
            return w.add(f"SURFACE_OF_LINEAR_EXTRUSION('',{c},{vec})"), False
        if t == 68:
            c = self.curve_geom(self.xt.node(s["profile"]))
            ax = w.add(f"AXIS1_PLACEMENT('',{w.point(s['base'])},{w.direction(s['axis'])})")
            return w.add(f"SURFACE_OF_REVOLUTION('',{c},{ax})"), False
        if t == 56:
            return self._blend(s), False
        raise Unsupported("surface:" + P.TYPE_NAMES.get(t, str(t)))

    def _swept_nurbs(self, s, nb: Nurbs):
        """Estrusione S(u,v) = C(u) + v D come NURBS: v limitato all'ingombro del modello lungo D (con margine)."""
        d = unit(s["sweep"])
        if self._all_pts is None:
            self._all_pts = [n["pvec"] for n in self.xt.nodes.values() if n.type == 29 and n.get("pvec")]
        p0 = nb.poles[0]
        vs = [dot(sub(p, p0), d) for p in self._all_pts] or [0.0, 1.0]
        span = max(vs) - min(vs)
        v0, v1 = min(vs) - 0.1 * span - 1e-4, max(vs) + 0.1 * span + 1e-4
        poles = [[add(p, mul(d, v0)), add(p, mul(d, v1))] for p in nb.poles]
        weights = [[w, w] for w in nb.weights] if nb.weights else None
        return NurbsSurf(nb.degree, 1, nb.knots, nb.mults, [v0, v1], [2, 2], poles, weights)

    def _bsurface(self, ns: NurbsSurf, scale=SCALE):
        w = self.w
        rows = []
        for row in ns.poles:
            rows.append("(" + ",".join(w.point(p, scale) for p in row) + ")")
        um = ",".join(str(m) for m in ns.u.mults)
        vm = ",".join(str(m) for m in ns.v.mults)
        uk = ",".join(_num(k) for k in ns.u.knots)
        vk = ",".join(_num(k) for k in ns.v.knots)
        cp = "(" + ",".join(rows) + ")"
        if ns.weights is None:
            return w.add(f"B_SPLINE_SURFACE_WITH_KNOTS('',{ns.u.degree},{ns.v.degree},{cp},.UNSPECIFIED.,.F.,.F.,.F.,({um}),({vm}),({uk}),({vk}),.UNSPECIFIED.)")
        wl = "(" + ",".join("(" + ",".join(_num(x) for x in row) + ")" for row in ns.weights) + ")"
        return w.add(f"(BOUNDED_SURFACE() B_SPLINE_SURFACE({ns.u.degree},{ns.v.degree},{cp},.UNSPECIFIED.,.F.,.F.,.F.) "
                     f"B_SPLINE_SURFACE_WITH_KNOTS(({um}),({vm}),({uk}),({vk}),.UNSPECIFIED.) GEOMETRIC_REPRESENTATION_ITEM() "
                     f"RATIONAL_B_SPLINE_SURFACE({wl}) REPRESENTATION_ITEM('') SURFACE())")

    def _bcurve(self, nb: Nurbs):
        w = self.w
        pts = ",".join(w.point(p) for p in nb.poles)
        mm = ",".join(str(m) for m in nb.mults)
        kk = ",".join(_num(k) for k in nb.knots)
        if nb.weights is None:
            return w.add(f"B_SPLINE_CURVE_WITH_KNOTS('',{nb.degree},({pts}),.UNSPECIFIED.,.F.,.F.,({mm}),({kk}),.UNSPECIFIED.)")
        ws = ",".join(_num(x) for x in nb.weights)
        return w.add(f"(BOUNDED_CURVE() B_SPLINE_CURVE({nb.degree},({pts}),.UNSPECIFIED.,.F.,.F.) B_SPLINE_CURVE_WITH_KNOTS(({mm}),({kk}),.UNSPECIFIED.) "
                     f"CURVE() GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_CURVE(({ws})) REPRESENTATION_ITEM(''))")

    def polyline_curve(self, pts):
        """Polilinea come B-spline di grado 1 (parametro = lunghezza dell'arco)."""
        clean = [pts[0]]
        for p in pts[1:]:
            if norm(sub(p, clean[-1])) > 1e-10:
                clean.append(p)
        if len(clean) < 2:
            raise Unsupported("geometry")
        knots = [0.0]
        for a, b in zip(clean, clean[1:]):
            knots.append(knots[-1] + norm(sub(b, a)) * SCALE)
        mults = [2] + [1] * (len(clean) - 2) + [2]
        return self._bcurve(Nurbs(1, knots, mults, clean, None, 3))

    # ---------- curve 3D (geometria esatta quando possibile)
    def curve_geom(self, c):
        key = c.index
        if key in self.curve_ref:
            return self.curve_ref[key]
        w, t = self.w, c.type
        if t == 30:
            vec = w.add(f"VECTOR('',{w.direction(c['direction'])},1.)")
            ref = w.add(f"LINE('',{w.point(c['pvec'])},{vec})")
        elif t == 31:
            ref = w.add(f"CIRCLE('',{w.axis2(c['centre'], c['normal'], c['x_axis'])},{_num(c['radius'] * SCALE)})")
        elif t == 32:
            ref = w.add(f"ELLIPSE('',{w.axis2(c['centre'], c['normal'], c['x_axis'])},{_num(c['major_radius'] * SCALE)},{_num(c['minor_radius'] * SCALE)})")
        elif t == 134:
            ref = self._bcurve(self.geo.ncurve(c))
        elif t == 133:
            ref = self.curve_geom(self.xt.node(c["basis_curve"]))
        elif t == 38:
            ref = self.polyline_curve(self.geo.chart_points(c))
            self.rep["intersection_polyline"] += 1
        elif t == 137:
            t0, t1 = self.geo.curve_range(c)
            ref = self.polyline_curve(self.geo.sample_curve(c, t0, t1, 48))
            self.rep["sp_sampled"] += 1
        else:
            raise Unsupported("surface:" + P.TYPE_NAMES.get(t, str(t)))
        self.curve_ref[key] = ref
        return ref

    @staticmethod
    def curve_sense(xt, c):
        """Verso dello spigolo rispetto al parametro naturale della curva geometrica scritta nello STEP."""
        s = c.get("sense", "+") != "-"
        if c.type == 133:
            b = xt.node(c["basis_curve"])
            return s == (b.get("sense", "+") != "-") if b else s
        return s

    # ---------- raccordo a palla: superficie NURBS ricostruita dai punti di contatto
    def _blend(self, s):
        ns = self.blend_nurbs(s)
        self.rep["blends_rebuilt"] += 1
        return self._bsurface(ns)

    def blend_nurbs(self, s):
        """NURBS che approssima il raccordo, con la stessa parametrizzazione di Parasolid: u = parametro della spina,
        v da 0 (contatto sulla prima superficie) a 1 (sulla seconda; al contrario se la spina ha verso negativo).
        Cosi' anche le SP-curve e le proiezioni sul raccordo si possono valutare."""
        geo = self.geo
        if s.index in geo._ns:
            return geo._ns[s.index]
        if s.index in self._building:
            raise Unsupported("blend")
        self._building.add(s.index)
        try:
            ns = self._blend_nurbs(s)
        finally:
            self._building.discard(s.index)
        geo._ns[s.index] = ns
        return ns

    def _blend_nurbs(self, s):
        xt, geo = self.xt, self.geo
        # 'R' = palla che rotola tra due superfici; 'E' = palla tra una superficie e uno spigolo vivo ("cliff edge"):
        # il supporto dello spigolo e' un BLENDED_EDGE degenere (range [0,0]) la cui spina e' lo spigolo stesso
        if s.get("blend_type") not in ("R", "E", None):
            raise Unsupported("blend_" + str(s.get("blend_type")))
        spine = xt.node(s["spine"])
        sups = [xt.node(i) for i in s.get("surface", [])]
        if spine is None or len(sups) != 2 or None in sups:
            raise Unsupported("blend")
        if spine.type == 38:
            centres, params = geo.chart_params(spine)
        else:
            t0, t1 = geo.curve_range(spine)
            params = [t0 + (t1 - t0) * k / 32 for k in range(33)]
            centres = [geo.curve_point(spine, tt) for tt in params]
        if len(centres) > 80:
            idx = sorted({int(i * (len(centres) - 1) / 79) for i in range(80)})
            centres = [centres[i] for i in idx]
            params = [params[i] for i in idx]
        reverse = spine.get("sense") == "-"
        rows = []
        for c in centres:
            a = self.project(sups[0], c)[0]
            b = self.project(sups[1], c)[0]
            if reverse:
                a, b = b, a
            da, db = sub(a, c), sub(b, c)
            ra, rb = norm(da), norm(db)
            if ra < 1e-12 or rb < 1e-12:
                raise Unsupported("blend")
            ang = math.acos(max(-1.0, min(1.0, dot(da, db) / (ra * rb))))
            rows.append((c, da, db, ang))
        # arco in due tratti razionali di grado 2 (5 poli) per ogni punto della spina
        poles, weights = [], []
        for c, da, db, ang in rows:
            rad = (norm(da) + norm(db)) / 2
            e1 = unit(da)
            e2 = sub(db, mul(e1, dot(db, e1)))
            e2 = unit(e2) if norm(e2) > 1e-15 else perp(e1)
            half = ang / 2
            pts, ws = [], []
            for k in range(5):
                if k % 2 == 0:
                    th = half * (k // 2)
                    pts.append(add(c, add(mul(e1, rad * math.cos(th)), mul(e2, rad * math.sin(th)))))
                    ws.append(1.0)
                else:
                    th = half * (k // 2) + half / 2
                    wk = math.cos(half / 2)
                    rr = rad / wk
                    pts.append(add(c, add(mul(e1, rr * math.cos(th)), mul(e2, rr * math.sin(th)))))
                    ws.append(wk)
            poles.append(pts)
            weights.append(ws)
        # parametri strettamente crescenti (punti doppi della chart tolti)
        keep = [0]
        for i in range(1, len(params)):
            if params[i] - params[keep[-1]] > 1e-12:
                keep.append(i)
        if len(keep) < 2:
            raise Unsupported("blend")
        poles = [poles[i] for i in keep]
        weights = [weights[i] for i in keep]
        uk = [params[i] for i in keep]
        um = [2] + [1] * (len(uk) - 2) + [2]
        return NurbsSurf(1, 2, uk, um, [0.0, 0.5, 1.0], [3, 2, 3], poles, weights)

    def project(self, s, p):
        """Punto della superficie piu' vicino a p (forma chiusa per le analitiche, Newton per le altre)."""
        t = s.type
        if t == 50:
            n = unit(s["normal"])
            return sub(p, mul(n, dot(sub(p, s["pvec"]), n))), n
        if t == 51:
            a = unit(s["axis"])
            q = sub(p, s["pvec"])
            axp = add(s["pvec"], mul(a, dot(q, a)))
            d = unit(sub(p, axp))
            return add(axp, mul(d, s["radius"])), d
        if t == 53:
            d = unit(sub(p, s["centre"]))
            return add(s["centre"], mul(d, s["radius"])), d
        if t == 54:
            a = unit(s["axis"])
            q = sub(p, s["centre"])
            radial = unit(sub(q, mul(a, dot(q, a))))
            ring = add(s["centre"], mul(radial, s["major_radius"]))
            d = unit(sub(p, ring))
            return add(ring, mul(d, s["minor_radius"])), d
        if t == 56 and not any(abs(r or 0) > 1e-12 for r in (s.get("range") or [0, 0])):
            return self._project_curve(self.xt.node(s["spine"]), p)
        return self._project_param(s, p)

    def _project_curve(self, c, p):
        """Punto piu' vicino a p su una curva (spigolo vivo di un raccordo 'cliff edge'), sulla polilinea campionata."""
        if c is None:
            raise Unsupported("blend")
        key = ("pts", c.index)
        pts = self._curve_pts.get(key)
        if pts is None:
            if c.type == 38:
                pts = self.geo.chart_points(c)
            else:
                t0, t1 = self.geo.curve_range(c)
                pts = self.geo.sample_curve(c, t0, t1, 64)
            self._curve_pts[key] = pts
        best, bd = pts[0], float("inf")
        for a, b in zip(pts, pts[1:]):
            ab = sub(b, a)
            L = dot(ab, ab)
            u = 0.0 if L == 0 else max(0.0, min(1.0, dot(sub(p, a), ab) / L))
            q = add(a, mul(ab, u))
            d = norm(sub(p, q))
            if d < bd:
                best, bd = q, d
        return best, unit(sub(p, best))

    def _project_param(self, s, p):
        geo = self.geo
        # campionamento grossolano dello spazio parametrico e poi discesa
        if s.type in (124, 56):
            ns = geo.nsurf(s) if s.type == 124 else self.blend_nurbs(s)
            u0, u1 = ns.u.range
            v0, v1 = ns.v.range
        elif s.type == 52:
            u0, u1, v0, v1 = 0.0, 2 * math.pi, -10.0, 10.0
            # forma chiusa del cono: si usa la discesa partendo dalla proiezione sull'asse
            a = unit(s["axis"])
            q = sub(p, s["pvec"])
            v = -dot(q, a)
            v0, v1 = v - 1.0, v + 1.0
        elif s.type == 60:
            b = self.xt.node(s["surface"])
            foot, n = self.project(b, p)
            d = s["offset"] * (1 if b["sense"] != "-" else -1)
            return add(foot, mul(n, d)), n
        else:
            raise Unsupported("blend_support:" + P.TYPE_NAMES.get(s.type, str(s.type)))
        best = None
        N = 12
        for i in range(N + 1):
            for j in range(N + 1):
                u = u0 + (u1 - u0) * i / N
                v = v0 + (v1 - v0) * j / N
                d = norm(sub(geo.surf_point(s, u, v), p))
                if best is None or d < best[0]:
                    best = (d, u, v)
        _, u, v = best
        du, dv = (u1 - u0) / N, (v1 - v0) / N
        for _ in range(40):
            improved = False
            for su, sv in ((du, 0), (-du, 0), (0, dv), (0, -dv)):
                uu, vv = min(max(u + su, u0), u1), min(max(v + sv, v0), v1)
                d = norm(sub(geo.surf_point(s, uu, vv), p))
                if d < best[0]:
                    best = (d, uu, vv)
                    u, v = uu, vv
                    improved = True
            if not improved:
                du /= 2
                dv /= 2
                if du < 1e-9 * max(1, abs(u1 - u0)) and dv < 1e-9 * max(1, abs(v1 - v0)):
                    break
        foot = geo.surf_point(s, u, v)
        return foot, geo.surf_normal(s, u, v)

    # ---------- topologia
    def vertex(self, v):
        if v.index in self.vert_ref:
            return self.vert_ref[v.index]
        pt = self.xt.node(v["point"])
        if pt is None or not pt.get("pvec"):
            raise Unsupported("topology")
        ref = self.w.add(f"VERTEX_POINT('',{self.w.point(pt['pvec'])})")
        self.vert_ref[v.index] = ref
        return ref

    def edge(self, e):
        if e.index in self.edge_ref:
            return self.edge_ref[e.index]
        xt, w = self.xt, self.w
        fin = xt.node(e["fin"])
        other = xt.node(fin["other"]) if fin else None
        vend = xt.node(fin["vertex"]) if fin else None
        vstart = xt.node(other["vertex"]) if other else None
        c = xt.node(e["curve"])
        if c is None:
            # spigolo tollerante: la geometria e' sulle SP-curve delle fin; si campiona e si orienta sui vertici
            fc = None
            for f in (fin, other):
                if f is not None and xt.node(f["curve"]) is not None:
                    fc = xt.node(f["curve"])
                    break
            if fc is None:
                raise Unsupported("topology")
            t0, t1 = self.geo.curve_range(fc)
            pts = self.geo.sample_curve(fc, t0, t1, 48)
            if vstart is not None and vend is not None:
                ps = xt.node(vstart["point"])["pvec"]
                if norm(sub(pts[0], ps)) > norm(sub(pts[-1], ps)):
                    pts.reverse()
                pts[0] = ps
                pts[-1] = xt.node(vend["point"])["pvec"]
            cref = self.polyline_curve(pts)
            same = True
            self.rep["tolerant_edges"] += 1
        else:
            cref = self.curve_geom(c)
            same = self.curve_sense(xt, c)
        if vstart is None or vend is None:
            # spigolo ad anello senza vertici: un vertice sul punto iniziale della curva
            p0 = self._curve_start(c)
            vref = w.add(f"VERTEX_POINT('',{w.point(p0)})")
            vs = ve = vref
        else:
            vs, ve = self.vertex(vstart), self.vertex(vend)
        ref = w.add(f"EDGE_CURVE('',{vs},{ve},{cref},{'.T.' if same else '.F.'})")
        self.edge_ref[e.index] = ref
        return ref

    def _curve_start(self, c):
        if c is None:
            raise Unsupported("topology")
        if c.type == 38:
            return self.geo.chart_points(c)[0]
        t0, _ = self.geo.curve_range(c)
        return self.geo.curve_point(c, t0)

    def face(self, f, color=None):
        xt, w = self.xt, self.w
        s = xt.node(f["surface"])
        if s is None:
            raise Unsupported("topology")
        sref, flip = self.surface(s)
        bounds = []
        for lp in xt.chain(f["loop"]):
            fins = []
            f0 = xt.node(lp["fin"])
            fi = f0
            guard = 0
            while fi is not None:
                fins.append(fi)
                fi = xt.node(fi["forward"])
                guard += 1
                if fi is None or fi.index == f0.index or guard > 100000:
                    break
            oes = []
            for fi in fins:
                e = xt.node(fi["edge"])
                if e is None:
                    continue  # anello isolato (solo un vertice)
                oes.append(w.add(f"ORIENTED_EDGE('',*,*,{self.edge(e)},{'.T.' if fi['sense'] != '-' else '.F.'})"))
            if oes:
                el = w.add(f"EDGE_LOOP('',({','.join(oes)}))")
                bounds.append(w.add(f"FACE_BOUND('',{el},.T.)"))
        same = (f["sense"] != "-") == (s.get("sense", "+") != "-")
        if flip:
            same = not same
        return w.add(f"ADVANCED_FACE('',({','.join(bounds)}),{sref},{'.T.' if same else '.F.'})")


# ---------------------------------------------------------------- struttura del modello (corpi, assiemi, nomi, colori)
def _name_attr(xt, node):
    for name, a in P.attributes_of(xt, node):
        if name in ("SDL/TYSA_NAME", "SWIMPLICITBODYNAME_ID_U", "SWBODYNAME_ID_U") or name.endswith("BODYNAME_ID_U"):
            s = P.attr_string(xt, a).strip()
            if s:
                return s
    return ""


def _color_attr(xt, node):
    for name, a in P.attributes_of(xt, node):
        if name == "SDL/TYSA_COLOUR":
            v = P.real_values(xt, a)
            if len(v) >= 3 and all(0 <= x <= 1.0001 for x in v[:3]):
                return tuple(v[:3])
    return None


def body_faces(xt, body):
    """Facce di un corpo raggruppate per shell (le shell delle regioni solide per i solidi)."""
    shells = defaultdict(list)
    regions = xt.chain(body["region"])
    solid = body.get("body_type") == 1
    for rg in regions:
        for sh in xt.chain(rg["shell"]):
            # facce "di dietro" (normale uscente dalla regione) e "di fronte" della shell
            back = xt.chain(sh["face"], "next")
            front = xt.chain(sh["front_face"], "next_front")
            if solid:
                if rg.get("type") == "S":
                    shells[sh.index].extend(back)
                    shells[sh.index].extend(f for f in front if f not in back)
            else:
                for f in back + front:
                    shells["sheet"].append(f)
    # nei fogli una faccia compare due volte (dietro di una shell, davanti dell'altra): una sola copia
    for k, lst in shells.items():
        seen, out = set(), []
        for f in lst:
            if f.index not in seen:
                seen.add(f.index)
                out.append(f)
        shells[k] = out
    return shells


class Model:
    """Parti e istanze di un file XT: parts = [(chiave, nome, corpo)], tree = albero di assieme."""

    def __init__(self, xt, name="Modello"):
        self.xt = xt
        self.name = name
        self.bodies = []      # nodi BODY da convertire
        self.instances = []   # (assembly_key, body_or_assembly_node, matrice 4x4 o None)
        self.assemblies = []  # assiemi radice
        root = xt.root
        if root is None:
            return
        if root.type == 12:
            self.bodies = xt.chain(root.index)
        elif root.type == 10:
            self.assemblies.append(root)
            self._walk_assembly(root)
        elif root.type == 101:  # partizione: tutti i corpi del mondo
            self.bodies = xt.chain(root["body"])
            for a in xt.chain(root["assembly"]):
                self.assemblies.append(a)
                self._walk_assembly(a)
        elif root.type == 74:  # elenco di parti
            for e in root.get("entries", []) or []:
                n = xt.node(e)
                if n is not None and n.type == 12:
                    self.bodies.append(n)
                elif n is not None and n.type == 10:
                    self.assemblies.append(n)
                    self._walk_assembly(n)
        self.bodies = [b for b in self.bodies if b.get("body_type") in (1, 3, 6)]

    def _walk_assembly(self, asm):
        for inst in self.xt.chain(asm["sub_instance"], "next_in_part"):
            part = self.xt.node(inst["part"])
            if part is None:
                continue
            tf = self.xt.node(inst["transform"])
            self.instances.append((asm.index, part, transform_matrix(tf) if tf else None))
            if part.type == 10:
                self._walk_assembly(part)


def transform_matrix(tf):
    """TRANSFORM -> (R 3x3 per righe, t, scala): x' = (R x + t) * s."""
    m = tf.get("rotation_matrix") or [1, 0, 0, 0, 1, 0, 0, 0, 1]
    t = tf.get("translation_vector") or (0, 0, 0)
    s = tf.get("scale") or 1.0
    return ([m[0:3], m[3:6], m[6:9]], t, s)


def _header(name):
    import time
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    return ("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('MB Visual: modello convertito da Parasolid'),'2;1');\n"
            f"FILE_NAME({_str(name)},'{ts}',(''),(''),'MB Visual','MB Visual','');\n"
            "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n")


class StepBuilder:
    """Costruisce un file STEP con una o piu' parti (prodotti) ed eventualmente un assieme che le posiziona."""

    def __init__(self, name):
        self.w = StepWriter()
        self.report = Counter()
        self.name = name
        w = self.w
        self.app = w.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')")
        w.add(f"APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,{self.app})")
        self.pctx = w.add(f"PRODUCT_CONTEXT('',{self.app},'mechanical')")
        self.pdctx = w.add(f"PRODUCT_DEFINITION_CONTEXT('part definition',{self.app},'design')")
        mm = w.add("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))")
        rad = w.add("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))")
        sr = w.add("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())")
        unc = w.add(f"UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-04),{mm},'distance_accuracy_value','')")
        self.ctx = w.add(f"(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT(({unc})) "
                         f"GLOBAL_UNIT_ASSIGNED_CONTEXT(({mm},{rad},{sr})) REPRESENTATION_CONTEXT('',''))")
        self.styled = []
        self.colors = {}
        self.face_log = []  # facce convertite nell'ordine di scrittura (per i collaudi)
        self.origin = None

    def _origin(self):
        if self.origin is None:
            self.origin = self.w.axis2((0, 0, 0), (0, 0, 1), (1, 0, 0))
        return self.origin

    def product(self, name):
        w = self.w
        prod = w.add(f"PRODUCT({_str(name)},{_str(name)},'',({self.pctx}))")
        w.add(f"PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,({prod}))")
        pdf = w.add(f"PRODUCT_DEFINITION_FORMATION('','',{prod})")
        pd = w.add(f"PRODUCT_DEFINITION('design','',{pdf},{self.pdctx})")
        pds = w.add(f"PRODUCT_DEFINITION_SHAPE('','',{pd})")
        return pd, pds

    def color(self, rgb):
        key = tuple(round(c, 4) for c in rgb)
        if key not in self.colors:
            w = self.w
            col = w.add(f"COLOUR_RGB('',{_num(key[0])},{_num(key[1])},{_num(key[2])})")
            fill = w.add(f"FILL_AREA_STYLE('',(FILL_AREA_STYLE_COLOUR('',{col})))")
            sss = w.add(f"SURFACE_SIDE_STYLE('',(SURFACE_STYLE_FILL_AREA({fill})))")
            psa = w.add(f"PRESENTATION_STYLE_ASSIGNMENT((SURFACE_STYLE_USAGE(.BOTH.,{sss})))")
            self.colors[key] = psa
        return self.colors[key]

    def style(self, item, rgb):
        if rgb:
            self.styled.append(self.w.add(f"STYLED_ITEM('',({self.color(rgb)}),{item})"))

    def part_from_bodies(self, xt, bodies, name):
        """Una parte (prodotto) con uno o piu' corpi Parasolid. Ritorna (pd, rappresentazione) o None se vuota."""
        conv = Converter(xt, self.w, self.report)
        items = []
        surface_model = False
        for bi, body in enumerate(bodies):
            bname = _name_attr(xt, body) or (name if len(bodies) == 1 else tr("srv_solidcad.corpo_di", name, bi + 1))
            bcolor = _color_attr(xt, body)
            groups = body_faces(xt, body)
            solid = body.get("body_type") == 1
            shells = []
            for key, faces in groups.items():
                frefs = []
                for f in faces:
                    self.report["faces"] += 1
                    try:
                        ref = conv.face(f)
                        frefs.append(ref)
                        self.face_log.append(f)
                        self.report["faces_ok"] += 1
                        fc = _color_attr(xt, f)
                        if fc and fc != bcolor:
                            self.style(ref, fc)
                    except (Unsupported, P.XTError, KeyError, TypeError, ValueError, ZeroDivisionError, IndexError) as e:
                        self.report["skip:" + (str(e) if isinstance(e, Unsupported) else "error")] += 1
                if frefs:
                    kind = "CLOSED_SHELL" if solid and len(frefs) == len(faces) else "OPEN_SHELL"
                    shells.append((kind, self.w.add(f"{kind}('',({','.join(frefs)}))")))
            if not shells:
                continue
            self.report["bodies"] += 1
            if solid and all(k == "CLOSED_SHELL" for k, _ in shells):
                # piu' shell chiuse: un solido per shell (piu' robusto delle cavita' per la sola visualizzazione)
                for _, r in shells:
                    it = self.w.add(f"MANIFOLD_SOLID_BREP({_str(bname)},{r})")
                    items.append(it)
                    self.style(it, bcolor)
            else:
                if solid:
                    self.report["open_solids"] += 1
                it = self.w.add(f"SHELL_BASED_SURFACE_MODEL({_str(bname)},({','.join(r for _, r in shells)}))")
                items.append(it)
                surface_model = True
                self.style(it, bcolor)
        if not items:
            return None
        pd, pds = self.product(name)
        kind = "MANIFOLD_SURFACE_SHAPE_REPRESENTATION" if surface_model else "ADVANCED_BREP_SHAPE_REPRESENTATION"
        rep = self.w.add(f"{kind}({_str(name)},({','.join(items + [self._origin()])}),{self.ctx})")
        self.w.add(f"SHAPE_DEFINITION_REPRESENTATION({pds},{rep})")
        return pd, rep

    def assembly(self, name, children):
        """children = [(pd, rep, (R, t, s) | None, nome istanza)]"""
        w = self.w
        pd, pds = self.product(name)
        axes = [self._origin()]
        links = []
        for i, (cpd, crep, m, iname) in enumerate(children):
            if m is None:
                ax = self._origin()
            else:
                R, t, s = m
                # x' = (R x + t) s : origine e assi della parte nel sistema dell'assieme
                o = mul(t, s)
                zc = (R[0][2], R[1][2], R[2][2])
                xc = (R[0][0], R[1][0], R[2][0])
                ax = w.axis2(o, zc, xc)
            axes.append(ax)
            links.append((cpd, crep, ax, iname or tr("srv_solidcad.istanza_n", i + 1)))
        arep = w.add(f"SHAPE_REPRESENTATION({_str(name)},({','.join(dict.fromkeys(axes))}),{self.ctx})")
        w.add(f"SHAPE_DEFINITION_REPRESENTATION({pds},{arep})")
        for i, (cpd, crep, ax, iname) in enumerate(links):
            nauo = w.add(f"NEXT_ASSEMBLY_USAGE_OCCURRENCE('{i + 1}',{_str(iname)},'',{pd},{cpd},$)")
            npds = w.add(f"PRODUCT_DEFINITION_SHAPE('','',{nauo})")
            idt = w.add(f"ITEM_DEFINED_TRANSFORMATION('','',{self._origin()},{ax})")
            rr = w.add(f"(REPRESENTATION_RELATIONSHIP('','',{crep},{arep}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION({idt}) SHAPE_REPRESENTATION_RELATIONSHIP())")
            w.add(f"CONTEXT_DEPENDENT_SHAPE_REPRESENTATION({rr},{npds})")
        return pd, arep

    def text(self):
        if self.styled:
            self.w.add(f"MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',({','.join(self.styled)}),{self.ctx})")
        return _header(self.name) + self.w.text() + "\nENDSEC;\nEND-ISO-10303-21;\n"


def xt_to_step(xt, name="Modello"):
    """Converte un file XT in testo STEP. Ritorna (step, resoconto) oppure (None, resoconto) se non c'e' geometria."""
    b = StepBuilder(name)
    m = Model(xt, name)
    if m.instances:
        # assieme Parasolid: una parte per corpo, sotto-assiemi annidati con la trasformazione di ogni istanza
        parts, asms = {}, {}

        def part(body):
            if body.index not in parts:
                parts[body.index] = b.part_from_bodies(xt, [body], _name_attr(xt, body) or tr("srv_solidcad.corpo_n", len(parts) + 1))
            return parts[body.index]

        def assembly(asm, depth=0):
            if asm.index in asms:
                return asms[asm.index]
            asms[asm.index] = None  # protezione dai cicli
            children = []
            if depth < 16:
                for inst in xt.chain(asm["sub_instance"], "next_in_part"):
                    p = xt.node(inst["part"])
                    if p is None:
                        continue
                    r = part(p) if p.type == 12 else assembly(p, depth + 1) if p.type == 10 else None
                    if r:
                        tf = xt.node(inst["transform"])
                        children.append((*r, transform_matrix(tf) if tf else None, _name_attr(xt, inst) or _name_attr(xt, p)))
            asms[asm.index] = b.assembly(_name_attr(xt, asm) or name, children) if children else None
            return asms[asm.index]

        children = []
        for a in m.assemblies:
            r = assembly(a)
            if r:
                children.append((*r, None, ""))
        for body in m.bodies:
            r = part(body)
            if r:
                children.append((*r, None, ""))
        if not children:
            return None, b.report
        if len(children) > 1:
            b.assembly(name, children)
    else:
        if not m.bodies or not b.part_from_bodies(xt, m.bodies, name):
            return None, b.report
    return b.text(), b.report
