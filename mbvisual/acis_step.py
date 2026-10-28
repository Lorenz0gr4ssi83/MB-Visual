# Conversione di un modello ShapeManager/ACIS (record di acis.py) in STEP AP214 (ISO 10303-21), scritta da zero.
# Topologia: body -> lump -> shell -> face -> loop -> coedge -> edge -> vertex -> point.
# Superfici: piano, cono/cilindro (anche ellittico), sfera, toro, B-spline (esatte o approssimazioni delle
# superfici procedurali). Curve: retta, ellisse/cerchio, B-spline (intcurve).
# Un elemento che non si converte viene saltato (la faccia che lo usa si perde) e finisce nel rapporto.
from __future__ import annotations

import math
from collections import Counter
from datetime import datetime

from . import acis
from .acis import Cursor, AcisError


def _f(x: float) -> str:
    if not math.isfinite(x):
        x = 0.0
    if x == 0:
        return "0."
    s = repr(float(x))
    if "e" in s or "E" in s:
        m, e = s.lower().split("e")
        if "." not in m:
            m += "."
        return f"{m}E{int(e)}"
    if "." not in s:
        s += "."
    return s


def _str(s: str) -> str:
    s = (s or "").replace("'", "''")
    out = []
    for ch in s:
        o = ord(ch)
        if 32 <= o < 127:
            out.append(ch)
        else:  # caratteri non ASCII nella codifica di ISO 10303-21
            out.append("\\X2\\%04X\\X0\\" % o if o < 0x10000 else "?")
    return "".join(out)


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a):
    return math.sqrt(_dot(a, a))


def _unit(a):
    n = _norm(a)
    return (a[0] / n, a[1] / n, a[2] / n) if n > 1e-300 else None


def _perp(a):
    x = (1.0, 0.0, 0.0) if abs(a[0]) < 0.9 else (0.0, 1.0, 0.0)
    return _unit(_cross(_cross(a, x), a)) or (0.0, 0.0, 1.0)


class Xf:
    """Trasformazione affine (righe = immagini degli assi) + scala, poi conversione di unita' in mm."""

    def __init__(self, rows=None, t=(0.0, 0.0, 0.0), scale=1.0, unit=1.0):
        self.r = rows or ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
        self.t = t
        self.s = scale
        self.u = unit
        self.ident = rows is None or (self.r == ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)) and scale == 1.0)

    def vec(self, v):
        if self.ident:
            return v
        r = self.r
        return (v[0] * r[0][0] + v[1] * r[1][0] + v[2] * r[2][0],
                v[0] * r[0][1] + v[1] * r[1][1] + v[2] * r[2][1],
                v[0] * r[0][2] + v[1] * r[1][2] + v[2] * r[2][2])

    def pt(self, p):
        q = self.vec(p)
        s, u, t = self.s, self.u, self.t
        return ((q[0] * s + t[0]) * u, (q[1] * s + t[1]) * u, (q[2] * s + t[2]) * u)

    def length(self, x):
        return x * self.s * self.u * (_norm(self.vec((1.0, 0.0, 0.0))) if not self.ident else 1.0)


class StepWriter:
    def __init__(self):
        self.lines: list[str] = []
        self.n = 0
        self._dirs: dict = {}
        self._pts: dict = {}

    def add(self, text: str) -> int:
        self.n += 1
        self.lines.append(f"#{self.n}={text};")
        return self.n

    def point(self, p) -> int:
        key = (round(p[0], 9), round(p[1], 9), round(p[2], 9))
        i = self._pts.get(key)
        if i is None:
            i = self._pts[key] = self.add(f"CARTESIAN_POINT('',({_f(p[0])},{_f(p[1])},{_f(p[2])}))")
        return i

    def direction(self, d) -> int:
        d = _unit(d) or (0.0, 0.0, 1.0)
        key = (round(d[0], 12), round(d[1], 12), round(d[2], 12))
        i = self._dirs.get(key)
        if i is None:
            i = self._dirs[key] = self.add(f"DIRECTION('',({_f(d[0])},{_f(d[1])},{_f(d[2])}))")
        return i

    def axis(self, origin, z, x) -> int:
        z = _unit(z) or (0.0, 0.0, 1.0)
        x = x and _unit(_sub(x, tuple(c * _dot(x, z) for c in z)))
        x = x or _perp(z)
        return self.add(f"AXIS2_PLACEMENT_3D('',#{self.point(origin)},#{self.direction(z)},#{self.direction(x)})")

    def text(self, name: str) -> str:
        now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        head = ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('MB Desk: conversione da Autodesk Inventor'),'2;1');",
                f"FILE_NAME('{_str(name)}.stp','{now}',(''),(''),'MB Desk','MB Desk','');",
                "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", "ENDSEC;", "DATA;"]
        return "\n".join(head + self.lines + ["ENDSEC;", "END-ISO-10303-21;", ""])


def _bspline_knots(mults: list[int], deg: int, ncp: int) -> list[int]:
    """Molteplicita' ACIS (estremi = grado) -> STEP (estremi = grado + 1)."""
    m = list(mults)
    if len(m) >= 2 and sum(m) == ncp + deg - 1:
        m[0] += 1
        m[-1] += 1
    return m


# ---------------------------------------------------------------- eliche (filettature, molle) senza approssimazione
# Dati ricavati dai file: centro C, vettore raggio iniziale M, secondo vettore N (verso di rotazione), passo P
# (spostamento per giro), conicita' k (raggio x (1 + k t / 2pi), filetti conici NPT), asse A.
# Punto: C + f(t) (M cos t + N sin t) + P t / 2pi, con f(t) = 1 + k t / 2pi.

def _read_helix(c: Cursor):
    t0, t1 = c.interval(), c.interval()
    C, M, N, P = c.vec(), c.vec(), c.vec(), c.vec()
    k = c.float() if c.peek() in (acis.DOUBLE, acis.DOUBLE2) else 0.0
    A = c.vec() if c.peek() in (acis.POS, acis.VEC) else _unit(P) or (0.0, 0.0, 1.0)
    return {"t0": t0, "t1": t1, "C": C, "M": M, "N": N, "P": P, "k": k, "A": _unit(A) or (0.0, 0.0, 1.0)}


def _helix_frame(hx, t):
    """(punto dell'elica, sua derivata, raggio R(t), sua derivata, raggio T(t) ruotato di 90 gradi, sua derivata)"""
    M, N, P, C, k = hx["M"], hx["N"], hx["P"], hx["C"], hx["k"]
    tau = 2 * math.pi
    f, df = 1.0 + k * t / tau, k / tau
    ct, st = math.cos(t), math.sin(t)
    R0 = tuple(M[i] * ct + N[i] * st for i in range(3))
    T0 = tuple(-M[i] * st + N[i] * ct for i in range(3))
    R = tuple(f * x for x in R0)
    T = tuple(f * x for x in T0)
    dR = tuple(df * R0[i] + f * T0[i] for i in range(3))
    dT = tuple(df * T0[i] - f * R0[i] for i in range(3))
    p = tuple(C[i] + R[i] + P[i] * t / tau for i in range(3))
    dp = tuple(dR[i] + P[i] / tau for i in range(3))
    return p, dp, R, dR, T, dT


def _hermite(fn, t0, t1, step=math.pi / 4):
    """Curva -> B-spline cubica a tratti di Hermite (un tratto ogni ottavo di giro: errore < 1e-5 del raggio).
    fn(t) -> (punto, derivata). Risultato nel formato di acis.read_bs3_curve."""
    n = max(1, int(math.ceil(abs(t1 - t0) / step)))
    h = (t1 - t0) / n
    pts, knots = [], []
    prev = None
    for s in range(n + 1):
        t = t0 + h * s
        p, d = fn(t)
        if prev is not None:
            pp, pd = prev
            pts.append(tuple(pp[i] + pd[i] * h / 3 for i in range(3)))
            pts.append(tuple(p[i] - d[i] * h / 3 for i in range(3)))
        pts.append(p)
        knots.append(t)
        prev = (p, d)
    return {"deg": 3, "closure": 0, "knots": knots, "mults": [3] * len(knots), "pts": pts, "w": None}


def helix_curve(hx):
    return _hermite(lambda t: _helix_frame(hx, t)[:2], hx["t0"], hx["t1"])


def helix_line_surface(hx, u0, u1, L):
    """Superficie rigata: segmento L (componenti su raggio, raggio ruotato, asse) che percorre l'elica."""
    A = hx["A"]
    rows = []
    for u in (u0, u1):
        def fn(t, u=u):
            p, dp, R, dR, T, dT = _helix_frame(hx, t)
            q = tuple(p[i] + u * (L[0] * R[i] + L[1] * T[i] + L[2] * A[i]) for i in range(3))
            dq = tuple(dp[i] + u * (L[0] * dR[i] + L[1] * dT[i]) for i in range(3))
            return q, dq
        rows.append(_hermite(fn, hx["t0"], hx["t1"]))
    return {"du": 1, "dv": 3, "cu": 0, "cv": 0, "ku": [u0, u1], "mu": [1, 1], "kv": rows[0]["knots"],
            "mv": rows[0]["mults"], "pts": [rows[0]["pts"], rows[1]["pts"]], "w": None}


_S2 = math.sqrt(0.5)
_CIRCLE = [(1, 0, 1), (1, 1, _S2), (0, 1, 1), (-1, 1, _S2), (-1, 0, 1), (-1, -1, _S2), (0, -1, 1), (1, -1, _S2), (1, 0, 1)]


def helix_tube_surface(hx, rc):
    """Tubo di raggio rc attorno all'elica, cerchio nel piano (raggio, asse): raccordi dei filetti.
    Cerchio razionale esatto in u (intero: la faccia lo rifila con i suoi spigoli), elica di Hermite in v."""
    A = hx["A"]
    spine = _hermite(lambda t: _helix_frame(hx, t)[:2], hx["t0"], hx["t1"])

    def radial(t):
        _p, _dp, R, dR, _T, _dT = _helix_frame(hx, t)
        n = _norm(R) or 1.0
        Rh = tuple(x / n for x in R)
        # derivata del versore: componente di dR perpendicolare a R, divisa per |R|
        d = tuple((dR[i] - Rh[i] * _dot(dR, Rh)) / n for i in range(3))
        return Rh, d
    rad = _hermite(radial, hx["t0"], hx["t1"])
    pts, ws = [], []
    for (a, b, wgt) in _CIRCLE:
        pts.append([tuple(spine["pts"][j][i] + rc * (a * rad["pts"][j][i] + b * A[i]) for i in range(3))
                    for j in range(len(spine["pts"]))])
        ws.append([wgt] * len(spine["pts"]))
    q = math.pi / 2
    return {"du": 2, "dv": 3, "cu": 1, "cv": 0, "ku": [0.0, q, 2 * q, 3 * q, 4 * q], "mu": [2, 2, 2, 2, 2],
            "kv": spine["knots"], "mv": spine["mults"], "pts": pts, "w": ws}


class Converter:
    def __init__(self, header: dict, records: list, subtypes: list, w: StepWriter | None = None):
        self.h = header
        self.r = records
        self.subs = subtypes
        self.w = w or StepWriter()
        self.unit = float(header.get("unit_mm") or 1.0)
        self.legacy = int(header.get("version", 0)) < 700  # prima della 7.0: niente id/pattern nei record
        self.report = Counter()
        self.missing = Counter()
        self._surf: dict = {}
        self._curve: dict = {}
        self._vert: dict = {}
        self._edge: dict = {}
        self.xf = Xf(unit=self.unit)

    # ------------------------------------------------ accesso ai record
    def rec(self, i: int):
        return self.r[i] if 0 <= i < len(self.r) else None

    def cur(self, rec, prefix: int | None = None) -> Cursor:
        """Cursore dopo l'intestazione comune: attributo, id, pattern (dalla 7.0)."""
        if prefix is None:
            prefix = 1 if self.legacy else 3
        c = Cursor(rec.v)
        # attributo (puntatore) + eventuale id (intero) + eventuale pattern (puntatore)
        c.ptr()
        if prefix >= 2 and c.peek() in (acis.INT,):
            c.next()
        if prefix >= 3 and c.peek() == acis.PTR:
            c.ptr()
        return c

    def subtype_at(self, c: Cursor):
        """Al SUB_START corrente: (valori, posizione) del contenuto, seguendo i "ref n"."""
        vals, pos = c.v, c.i
        for _ in range(8):
            if pos + 2 < len(vals) and vals[pos + 1][1] == "ref" and vals[pos + 2][0] == acis.INT:
                k = vals[pos + 2][1]
                if 0 <= k < len(self.subs):
                    rec, p = self.subs[k]
                    vals, pos = rec.v, p
                    continue
            break
        return vals, pos

    # ------------------------------------------------ superfici
    def surface(self, idx: int):
        """-> (id STEP, stesso verso della normale ACIS: bool) o None"""
        if idx in self._surf:
            return self._surf[idx]
        rec = self.rec(idx)
        res = None
        try:
            res = self._surface(rec) if rec else None
        except (AcisError, IndexError, ValueError, TypeError, ZeroDivisionError):
            res = None
        if res is None and rec is not None:
            self.missing["superficie " + self._subname(rec)] += 1
        self._surf[idx] = res
        return res

    def _subname(self, rec):
        name = rec.type
        for k, (t, v) in enumerate(rec.v):
            if t == acis.SUB_START and k + 1 < len(rec.v):
                return f"{name} ({rec.v[k + 1][1]})"
        return name

    def _surface(self, rec):
        w, X = self.w, self.xf
        t = rec.type
        c = self.cur(rec)
        if t == "plane-surface":
            o, n, u = c.vec(), c.vec(), c.vec()
            ax = w.axis(X.pt(o), X.vec(n), X.vec(u))
            return w.add(f"PLANE('',#{ax})"), True
        if t == "cone-surface":
            o, n, maj = c.vec(), c.vec(), c.vec()
            ratio = c.float()
            c.interval()
            if c.peek() in (acis.TRUE, acis.FALSE):  # secondo estremo dell'intervallo (alcune versioni)
                c.interval()
            s, co = c.float(), c.float()
            R = _norm(maj)
            O, N, M = X.pt(o), X.vec(n), X.vec(maj)
            Rm = X.length(R)
            outward = co > 0
            if abs(s) < 1e-12:
                if abs(ratio - 1.0) < 1e-9:
                    return w.add(f"CYLINDRICAL_SURFACE('',#{w.axis(O, N, M)},{_f(Rm)})"), outward
                ell = w.add(f"ELLIPSE('',#{w.axis(O, N, M)},{_f(Rm)},{_f(Rm * ratio)})")
                vec = w.add(f"VECTOR('',#{w.direction(N)},1.)")
                return w.add(f"SURFACE_OF_LINEAR_EXTRUSION('',#{ell},#{vec})"), outward == (_dot(_cross(M, N), N) >= 0)
            tan = s / co
            d = N if tan > 0 else tuple(-x for x in N)
            semi = math.atan(abs(tan))
            if abs(ratio - 1.0) > 1e-6:
                self.report["coni ellittici approssimati"] += 1
            return w.add(f"CONICAL_SURFACE('',#{w.axis(O, d, M)},{_f(Rm)},{_f(semi)})"), outward
        if t == "sphere-surface":
            o = c.vec()
            r = c.float()
            uo = c.vec()
            pole = c.vec() if c.peek() in (acis.POS, acis.VEC) else _perp(uo)
            ax = w.axis(X.pt(o), X.vec(pole), X.vec(uo))
            return w.add(f"SPHERICAL_SURFACE('',#{ax},{_f(X.length(abs(r)))})"), r > 0
        if t == "torus-surface":
            o, n = c.vec(), c.vec()
            R, r = c.float(), c.float()
            uo = c.vec() if c.peek() in (acis.POS, acis.VEC) else _perp(n)
            ax = w.axis(X.pt(o), X.vec(n), X.vec(uo))
            if abs(R) <= abs(r) + 1e-12:
                self.report["tori degeneri"] += 1
            return w.add(f"TOROIDAL_SURFACE('',#{ax},{_f(X.length(abs(R)))},{_f(X.length(abs(r)))})"), r > 0
        if t == "spline-surface":
            rev = c.bool() if c.peek() in (acis.TRUE, acis.FALSE) else False
            if c.peek() != acis.SUB_START:
                return None
            vals, pos = self.subtype_at(c)
            bs = acis.find_bs3(vals, pos, surface=True)
            if bs is None:
                return self._procedural_surface(vals, pos, rev)
            return self.bspline_surface(bs), not rev
        return None

    def _procedural_surface(self, vals, pos, rev):
        """Superfici procedurali senza approssimazione salvata: estrusione e rivoluzione di una curva."""
        name = vals[pos + 1][1] if pos + 1 < len(vals) else ""
        w, X = self.w, self.xf
        if name in ("helix_spl_line", "helix_spl_circ"):
            return self._helix_surface(name, vals, pos, rev)
        if name in ("cyl_spl_sur", "cylsur", "rot_spl_sur", "rotsur"):
            # la curva generatrice e' il primo blocco annidato
            k = pos + 1
            while k < len(vals) and vals[k][0] != acis.SUB_START:
                k += 1
            if k >= len(vals):
                return None
            cb = acis.find_bs3(vals, k, surface=False)
            if cb is None:
                return None
            # salta il blocco della curva e legge i vettori che seguono
            c = Cursor(vals, k + 1)
            c.skip_subtype()
            vecs = []
            while c.more() and len(vecs) < 2 and c.peek() != acis.SUB_END:
                t, v = c.next()
                if t in (acis.POS, acis.VEC):
                    vecs.append(v)
            curve = self.bspline_curve(cb)
            if name.startswith("cyl") and vecs:
                d = X.vec(vecs[0])
                vec = w.add(f"VECTOR('',#{w.direction(d)},1.)")
                self.report["superfici di estrusione ricostruite"] += 1
                return w.add(f"SURFACE_OF_LINEAR_EXTRUSION('',#{curve},#{vec})"), not rev
            if name.startswith("rot") and len(vecs) >= 2:
                ax = w.add(f"AXIS1_PLACEMENT('',#{w.point(X.pt(vecs[0]))},#{w.direction(X.vec(vecs[1]))})")
                self.report["superfici di rivoluzione ricostruite"] += 1
                return w.add(f"SURFACE_OF_REVOLUTION('',#{curve},#{ax})"), not rev
        return None

    def _helix_surface(self, name, vals, pos, rev):
        """Superfici elicoidali (filettature modellate, molle): ricostruite come B-spline dai dati dell'elica."""
        c = Cursor(vals, pos + 2)
        if c.peek() == acis.INT:
            c.next()  # versione del sottotipo
        nums = []
        while c.more() and c.peek() not in (acis.POS, acis.VEC):
            t, v = c.next()
            if t == acis.TRUE:
                nums.append(c.float())
            elif t == acis.FALSE:
                nums.append(None)
            elif t in (acis.DOUBLE, acis.DOUBLE2):
                nums.append(v)
        if len(nums) < 4 or None in nums[:4]:
            return None
        C, M, N, P = c.vec(), c.vec(), c.vec(), c.vec()
        k = c.float() if c.peek() in (acis.DOUBLE, acis.DOUBLE2) else 0.0
        A = c.vec()
        hx = {"t0": nums[2], "t1": nums[3], "C": C, "M": M, "N": N, "P": P, "k": k, "A": _unit(A) or (0.0, 0.0, 1.0)}
        while c.more() and c.peek() in (acis.NAME, acis.STR):  # null_surface null_surface nullbs nullbs
            c.next()
        if name == "helix_spl_line":
            L = c.vec()
            bs = helix_line_surface(hx, nums[0], nums[1], L)
            same = True
        else:
            rc = abs(c.float())
            bs = helix_tube_surface(hx, rc)
            # verso del cerchio: con il valore pi dopo gli intervalli il cerchio gira al contrario (normale opposta)
            extra = nums[4] if len(nums) > 4 and nums[4] is not None else 0.0
            same = abs(abs(extra) - math.pi) > 1e-6
        self.report["superfici elicoidali ricostruite"] += 1
        return self.bspline_surface(bs), same != rev

    def bspline_surface(self, bs) -> int:
        w, X = self.w, self.xf
        ncu, ncv = len(bs["pts"]), len(bs["pts"][0])
        mu = _bspline_knots(bs["mu"], bs["du"], ncu)
        mv = _bspline_knots(bs["mv"], bs["dv"], ncv)
        rows = ",".join("(" + ",".join(f"#{w.point(X.pt(p))}" for p in row) + ")" for row in bs["pts"])
        common = (f"{bs['du']},{bs['dv']},({rows}),.UNSPECIFIED.,{'.T.' if bs['cu'] else '.F.'},"
                  f"{'.T.' if bs['cv'] else '.F.'},.F.")
        kn = (f"({','.join(map(str, mu))}),({','.join(map(str, mv))}),({','.join(_f(k) for k in bs['ku'])}),"
              f"({','.join(_f(k) for k in bs['kv'])}),.UNSPECIFIED.")
        if bs["w"]:
            ws = ",".join("(" + ",".join(_f(x) for x in row) + ")" for row in bs["w"])
            return w.add(f"(BOUNDED_SURFACE()B_SPLINE_SURFACE({common})B_SPLINE_SURFACE_WITH_KNOTS({kn})"
                         f"GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(({ws}))REPRESENTATION_ITEM('')SURFACE())")
        return w.add(f"B_SPLINE_SURFACE_WITH_KNOTS('',{common},{kn})")

    # ------------------------------------------------ curve
    def bspline_curve(self, bs) -> int:
        w, X = self.w, self.xf
        ncp = len(bs["pts"])
        m = _bspline_knots(bs["mults"], bs["deg"], ncp)
        pts = ",".join(f"#{w.point(X.pt(p))}" for p in bs["pts"])
        closed = ".T." if bs["closure"] else ".F."
        kn = f"({','.join(map(str, m))}),({','.join(_f(k) for k in bs['knots'])}),.UNSPECIFIED."
        if bs["w"]:
            ws = ",".join(_f(x) for x in bs["w"])
            return w.add(f"(BOUNDED_CURVE()B_SPLINE_CURVE({bs['deg']},({pts}),.UNSPECIFIED.,{closed},.F.)"
                         f"B_SPLINE_CURVE_WITH_KNOTS({kn})CURVE()GEOMETRIC_REPRESENTATION_ITEM()"
                         f"RATIONAL_B_SPLINE_CURVE(({ws}))REPRESENTATION_ITEM(''))")
        return w.add(f"B_SPLINE_CURVE_WITH_KNOTS('',{bs['deg']},({pts}),.UNSPECIFIED.,{closed},.F.,{kn})")

    def curve(self, idx: int):
        """-> (id STEP, stesso verso della curva ACIS) o None"""
        if idx in self._curve:
            return self._curve[idx]
        rec = self.rec(idx)
        res = None
        try:
            res = self._curve_(rec) if rec else None
        except (AcisError, IndexError, ValueError, TypeError, ZeroDivisionError):
            res = None
        if res is None and rec is not None:
            self.missing["curva " + self._subname(rec)] += 1
        self._curve[idx] = res
        return res

    def _curve_(self, rec):
        w, X = self.w, self.xf
        t = rec.type
        c = self.cur(rec)
        if t == "straight-curve":
            o, d = c.vec(), c.vec()
            vec = w.add(f"VECTOR('',#{w.direction(X.vec(d))},1.)")
            return w.add(f"LINE('',#{w.point(X.pt(o))},#{vec})"), True
        if t == "ellipse-curve":
            o, n, maj = c.vec(), c.vec(), c.vec()
            ratio = c.float()
            R = X.length(_norm(maj))
            ax = w.axis(X.pt(o), X.vec(n), X.vec(maj))
            if abs(ratio - 1.0) < 1e-9:
                return w.add(f"CIRCLE('',#{ax},{_f(R)})"), True
            return w.add(f"ELLIPSE('',#{ax},{_f(R)},{_f(R * ratio)})"), True
        if t == "intcurve-curve":
            rev = c.bool() if c.peek() in (acis.TRUE, acis.FALSE) else False
            if c.peek() != acis.SUB_START:
                return None
            vals, pos = self.subtype_at(c)
            bs = acis.find_bs3(vals, pos, surface=False)
            if bs is None and pos + 1 < len(vals) and vals[pos + 1][1] == "helix_int_cur":
                hc = Cursor(vals, pos + 2)
                if hc.peek() == acis.INT:
                    hc.next()
                bs = helix_curve(_read_helix(hc))
            if bs is None:
                return None
            return self.bspline_curve(bs), not rev
        return None

    # ------------------------------------------------ topologia
    def vertex(self, idx: int):
        if idx in self._vert:
            return self._vert[idx]
        rec = self.rec(idx)
        res = None
        if rec is not None and rec.type.endswith("vertex"):
            c = self.cur(rec)
            c.ptr()  # spigolo
            if c.peek() == acis.INT:
                c.next()
            prec = self.rec(c.ptr())
            if prec is not None and prec.type == "point":
                p = self.cur(prec).vec()
                res = self.w.add(f"VERTEX_POINT('',#{self.w.point(self.xf.pt(p))})")
        self._vert[idx] = res
        return res

    def edge(self, idx: int):
        """-> id EDGE_CURVE o None (spigolo degenere senza curva: si salta)"""
        if idx in self._edge:
            return self._edge[idx]
        rec = self.rec(idx)
        res = None
        if rec is not None:
            c = self.cur(rec)
            vs = c.ptr()
            if c.peek() in (acis.DOUBLE, acis.DOUBLE2):
                c.next()
            ve = c.ptr()
            if c.peek() in (acis.DOUBLE, acis.DOUBLE2):
                c.next()
            c.ptr()  # coedge
            ci = c.ptr()
            rev = c.bool() if c.peek() in (acis.TRUE, acis.FALSE) else False
            v1, v2 = self.vertex(vs), self.vertex(ve)
            if ci < 0 or v1 is None or v2 is None:
                res = "degenere" if ci < 0 else None
            else:
                cv = self.curve(ci)
                if cv is None:
                    # ripiego: corda rettilinea tra i vertici (la faccia resta, con un bordo approssimato)
                    self.report["spigoli approssimati con un segmento"] += 1
                    res = self.w.add(f"EDGE_CURVE('',#{v1},#{v2},#{self._chord(vs, ve)},.T.)") if vs != ve else None
                else:
                    same = cv[1] != rev
                    res = self.w.add(f"EDGE_CURVE('',#{v1},#{v2},#{cv[0]},{'.T.' if same else '.F.'})")
        self._edge[idx] = res
        return res

    def _chord(self, vs, ve):
        def pos(vi):
            c = self.cur(self.rec(vi))
            c.ptr()
            if c.peek() == acis.INT:
                c.next()
            return self.xf.pt(self.cur(self.rec(c.ptr())).vec())
        a, b = pos(vs), pos(ve)
        vec = self.w.add(f"VECTOR('',#{self.w.direction(_sub(b, a))},1.)")
        return self.w.add(f"LINE('',#{self.w.point(a)},#{vec})")

    def face(self, rec):
        """-> (id ADVANCED_FACE o None, chiusa: tutti i coedge hanno un compagno)"""
        c = self.cur(rec)
        c.ptr()  # faccia successiva
        loop_i = c.ptr()
        c.ptr()  # shell
        c.ptr()  # subshell
        surf_i = c.ptr()
        reversed_ = c.bool()
        s = self.surface(surf_i)
        if s is None:
            return None, False
        closed = True
        bounds = []
        seen = 0
        while loop_i >= 0 and seen < 10000:
            seen += 1
            lrec = self.rec(loop_i)
            if lrec is None:
                break
            lc = self.cur(lrec)
            nxt = lc.ptr()
            first = lc.ptr()
            oes = []
            ce = first
            guard = 0
            ok = True
            while ce >= 0 and guard < 100000:
                guard += 1
                crec = self.rec(ce)
                cc = self.cur(crec)
                cnext = cc.ptr()
                cc.ptr()  # prev
                partner = cc.ptr()
                ei = cc.ptr()
                sense_rev = cc.bool()
                if partner < 0 or partner == ce:
                    closed = False
                e = self.edge(ei)
                if e is None:
                    ok = False
                elif e != "degenere":
                    oes.append(self.w.add(f"ORIENTED_EDGE('',*,*,#{e},{'.F.' if sense_rev else '.T.'})"))
                ce = cnext
                if ce == first:
                    break
            if not ok:
                self.missing["facce con spigoli non convertibili"] += 1
                return None, False
            if oes:
                el = self.w.add(f"EDGE_LOOP('',({','.join(f'#{o}' for o in oes)}))")
                bounds.append(self.w.add(f"FACE_BOUND('',#{el},.T.)"))
            loop_i = nxt
        same = (not reversed_) == s[1]
        fid = self.w.add(f"ADVANCED_FACE('',({','.join(f'#{b}' for b in bounds)}),#{s[0]},{'.T.' if same else '.F.'})")
        return fid, closed

    def body_xf(self, body):
        c = self.cur(body)
        c.ptr()  # lump
        c.ptr()  # wire
        ti = c.ptr() if c.peek() == acis.PTR else -1
        t = self.rec(ti)
        if t is None or t.type != "transform":
            return Xf(unit=self.unit)
        tc = Cursor(t.v)
        tc.ptr()
        if tc.peek() == acis.INT:
            tc.next()
        vecs = []
        scale = None
        while tc.more() and len(vecs) < 4:
            tt, v = tc.next()
            if tt in (acis.POS, acis.VEC):
                vecs.append(v)
            elif tt == acis.STR and len(v.split()) >= 12:
                # matrice scritta come testo dentro il binario (file creati da ezdxf)
                try:
                    nums = [float(x) for x in v.split()[:13]]
                except ValueError:
                    continue
                vecs = [tuple(nums[k:k + 3]) for k in range(0, 12, 3)]
                scale = nums[12] if len(nums) > 12 else 1.0
        if scale is None:
            scale = tc.float() if tc.peek() in (acis.DOUBLE, acis.DOUBLE2) else 1.0
        if len(vecs) < 4:
            return Xf(unit=self.unit)
        return Xf(rows=tuple(vecs[:3]), t=vecs[3], scale=scale, unit=self.unit)

    def bodies(self):
        """Elementi STEP (MANIFOLD_SOLID_BREP / SHELL_BASED_SURFACE_MODEL), uno per shell."""
        items = []
        nfaces = 0
        for b in self.r:
            if b.type != "body":
                continue
            self.xf = self.body_xf(b)
            self._surf, self._curve, self._vert, self._edge = {}, {}, {}, {}
            c = self.cur(b)
            lump_i = c.ptr()
            guard = 0
            while lump_i >= 0 and guard < 100000:
                guard += 1
                lump = self.rec(lump_i)
                if lump is None:
                    break
                lc = self.cur(lump)
                next_lump = lc.ptr()
                shell_i = lc.ptr()
                while shell_i >= 0:
                    sh = self.rec(shell_i)
                    if sh is None:
                        break
                    sc = self.cur(sh)
                    next_shell = sc.ptr()
                    sc.ptr()  # subshell
                    face_i = sc.ptr()
                    faces, closed = [], True
                    while face_i >= 0:
                        f = self.rec(face_i)
                        if f is None:
                            break
                        nfaces += 1
                        try:
                            fid, cl = self.face(f)
                        except (AcisError, IndexError, ValueError, TypeError, ZeroDivisionError, AttributeError):
                            fid, cl = None, False
                            self.missing["facce non leggibili"] += 1
                        if fid is None:
                            closed = False
                        else:
                            faces.append(fid)
                            closed = closed and cl
                        face_i = self.cur(f).ptr()
                    if faces:
                        fl = ",".join(f"#{x}" for x in faces)
                        if closed:
                            shid = self.w.add(f"CLOSED_SHELL('',({fl}))")
                            items.append(self.w.add(f"MANIFOLD_SOLID_BREP('',#{shid})"))
                        else:
                            shid = self.w.add(f"OPEN_SHELL('',({fl}))")
                            items.append(self.w.add(f"SHELL_BASED_SURFACE_MODEL('',(#{shid}))"))
                        self.report["facce convertite"] += len(faces)
                    shell_i = next_shell
                lump_i = next_lump
        self.report["facce totali"] += nfaces
        return items


def product(w: StepWriter, name: str, items: list[int], color=None) -> int:
    """Prodotto STEP con rappresentazione B-rep, unita' mm e colore facoltativo."""
    ctx = w.add("APPLICATION_CONTEXT('automotive design')")
    w.add(f"APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#{ctx})")
    pc = w.add(f"PRODUCT_CONTEXT('',#{ctx},'mechanical')")
    pr = w.add(f"PRODUCT('{_str(name)}','{_str(name)}','',(#{pc}))")
    pdf = w.add(f"PRODUCT_DEFINITION_FORMATION('','',#{pr})")
    pdc = w.add(f"PRODUCT_DEFINITION_CONTEXT('part definition',#{ctx},'design')")
    pd = w.add(f"PRODUCT_DEFINITION('design','',#{pdf},#{pdc})")
    pds = w.add(f"PRODUCT_DEFINITION_SHAPE('','',#{pd})")
    lu = w.add("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))")
    au = w.add("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))")
    su = w.add("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())")
    unc = w.add(f"UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#{lu},'distance_accuracy_value','')")
    gctx = w.add(f"(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#{unc}))"
                 f"GLOBAL_UNIT_ASSIGNED_CONTEXT((#{lu},#{au},#{su}))REPRESENTATION_CONTEXT('',''))")
    origin = w.axis((0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
    rep = w.add(f"ADVANCED_BREP_SHAPE_REPRESENTATION('{_str(name)}',({','.join(f'#{i}' for i in [origin] + items)}),#{gctx})")
    w.add(f"SHAPE_DEFINITION_REPRESENTATION(#{pds},#{rep})")
    if color and items:
        r, g, b = color
        col = w.add(f"COLOUR_RGB('',{_f(r)},{_f(g)},{_f(b)})")
        fasc = w.add(f"FILL_AREA_STYLE_COLOUR('',#{col})")
        fas = w.add(f"FILL_AREA_STYLE('',(#{fasc}))")
        ssfa = w.add(f"SURFACE_STYLE_FILL_AREA(#{fas})")
        sss = w.add(f"SURFACE_SIDE_STYLE('',(#{ssfa}))")
        ssu = w.add(f"SURFACE_STYLE_USAGE(.BOTH.,#{sss})")
        psa = w.add(f"PRESENTATION_STYLE_ASSIGNMENT((#{ssu}))")
        styled = [w.add(f"STYLED_ITEM('',(#{psa}),#{i})") for i in items]
        w.add(f"MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',({','.join(f'#{s}' for s in styled)}),#{gctx})")
    return pr


def sab_to_step(blobs: list, name: str, color=None) -> tuple[str, dict]:
    """Dati ShapeManager (binari SAB o testo SAT) -> testo STEP + rapporto {facce, mancanti}."""
    w = StepWriter()
    items, report, missing = [], Counter(), Counter()
    for blob in blobs:
        try:
            header, records, subtypes = acis.parse_any(blob)
        except (AcisError, IndexError, ValueError) as e:
            missing[f"blocco non leggibile ({e})"] += 1
            continue
        conv = Converter(header, records, subtypes, w)
        items += conv.bodies()
        report.update(conv.report)
        missing.update(conv.missing)
    product(w, name, items, color)
    return w.text(name), {"report": dict(report), "missing": dict(missing), "items": len(items)}
