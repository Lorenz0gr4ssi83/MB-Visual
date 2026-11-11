"""Isometrici delle tubazioni del modellatore: un foglio A3 orizzontale per linea, non in scala (come gli isometrici di
officina), con linea d'asse, quote tra i nodi, quote di livello, coordinate di partenza e arrivo, freccia del nord, simboli
di valvole, flange e supporti, distinta dei materiali della linea e cartiglio (senza nome di ditta: lo completa l'utente).

Ingresso (dall'interfaccia, dati d'impianto dei corpi gia' calcolati dal motore):
  {"nome": str, "linee": [{"id", "linea", "misura", "spec", "materiale", "pn", "raggio", "lunghezza", "nodi": [[x,y,z]...],
                           "componenti": [{"tipo": "valve|flanges|flange", "pos": [x,y,z]}],
                           "supporti": [{"tipo": "floor|hanger", "pos": [x,y,z]}]}]}
Uscita: PDF (PyMuPDF) o DXF (ezdxf, fogli affiancati nel modello, unita' mm della carta).

Proiezione: X verso destra in alto a 30 gradi, Y verso sinistra in alto a 30 gradi, Z verticale. Le lunghezze disegnate
sono compresse (radice della lunghezza vera) cosi' i tratti corti restano leggibili; le quote riportano le misure vere."""
from __future__ import annotations

import datetime
import math

from .i18n import t

W, H = 420.0, 297.0  # A3 orizzontale, mm
AREA = (15.0, 15.0, 285.0, 230.0)  # zona del disegno: x0, y0 (dal basso), x1, y1
C30, S30 = math.cos(math.radians(30)), 0.5


def _proj(v):
    return ((v[0] - v[1]) * C30, (v[0] + v[1]) * S30 + v[2])


def _sub(a, b):
    return [a[i] - b[i] for i in range(len(a))]


def _len(v):
    return math.sqrt(sum(x * x for x in v))


class Sheet:
    """Primitive del foglio in mm della carta (y verso l'alto)."""

    def __init__(self):
        self.items = []

    def line(self, a, b, w=0.25):
        self.items.append(("l", a, b, w))

    def poly(self, pts, w=0.25, fill=False, close=True):
        self.items.append(("p", pts, w, fill, close))

    def circle(self, c, r, w=0.25, fill=False):
        self.items.append(("c", c, r, w, fill))

    def text(self, p, s, h=2.5, ang=0.0, align="l"):
        self.items.append(("t", p, str(s), h, ang, align))


def _fmt(v):
    return f"{v:.0f}"


def _elev(z):
    return f"EL {z:+.0f}"


def _readable(ang):
    a = (ang + 180) % 360 - 180
    if a > 90:
        a -= 180
    elif a < -90:
        a += 180
    return a


def layout(group, nome, n_sheet, tot):
    """Disegna una linea (una o piu' tubazioni con lo stesso numero di linea: tubazione principale e diramazioni) su un foglio.
    Una tubazione sola: lunghezze compresse (radice della vera) perche' i tratti corti restino leggibili. Piu' tubazioni: proiezione
    proporzionale, cosi' le diramazioni partono dal punto giusto. Le quote riportano sempre le misure vere."""
    if isinstance(group, dict):
        group = [group]
    S = Sheet()
    rami = []
    for line in group:
        N = [list(map(float, q)) for q in line["nodi"]]
        if len(group) == 1:
            P = [(0.0, 0.0)]
            for i in range(1, len(N)):
                d = _sub(N[i], N[i - 1])
                L = _len(d) or 1e-9
                q = _proj([x / L for x in d])
                k = math.sqrt(L)
                P.append((P[-1][0] + q[0] * k, P[-1][1] + q[1] * k))
        else:
            P = [_proj(q) for q in N]
        rami.append({"line": line, "N": N, "P": P})
    xs = [q[0] for r in rami for q in r["P"]]
    ys = [q[1] for r in rami for q in r["P"]]
    bw, bh = max(max(xs) - min(xs), 1e-6), max(max(ys) - min(ys), 1e-6)
    x0, y0, x1, y1 = AREA
    m = 25.0
    sc = min((x1 - x0 - 2 * m) / bw, (y1 - y0 - 2 * m) / bh)
    if len(group) == 1:
        sc = min(sc, 4.0)
    ox = x0 + (x1 - x0 - bw * sc) / 2 - min(xs) * sc
    oy = y0 + (y1 - y0 - bh * sc) / 2 - min(ys) * sc
    for r in rami:
        r["Q"] = [(ox + q[0] * sc, oy + q[1] * sc) for q in r["P"]]

    def at(r, pos):
        """Punto 3D sulla tubazione -> punto della carta e direzione del tratto."""
        N, Q = r["N"], r["Q"]
        best = None
        for i in range(len(N) - 1):
            a, b = N[i], N[i + 1]
            d = _sub(b, a)
            L2 = sum(x * x for x in d) or 1e-12
            tt = max(0.0, min(1.0, sum((pos[k] - a[k]) * d[k] for k in range(3)) / L2))
            c = [a[k] + d[k] * tt for k in range(3)]
            dist = _len(_sub(pos, c))
            if best is None or dist < best[0]:
                best = (dist, i, tt)
        _d, i, tt = best
        a, b = Q[i], Q[i + 1]
        u = (b[0] - a[0], b[1] - a[1])
        L = math.hypot(*u) or 1
        return (a[0] + u[0] * tt, a[1] + u[1] * tt), (u[0] / L, u[1] / L)

    counts, sup_all = {}, []
    for ri, r in enumerate(rami):
        N, Q, line = r["N"], r["Q"], r["line"]
        # linea d'asse (spessa) e nodi
        for i in range(len(Q) - 1):
            S.line(Q[i], Q[i + 1], 0.7)
        for i, q in enumerate(Q):
            if 0 < i < len(Q) - 1:
                S.circle(q, 0.8, 0.25, True)  # punto di intersezione (curva)
        # quote tra i nodi, parallele al tratto
        for i in range(len(Q) - 1):
            a, b = Q[i], Q[i + 1]
            u = (b[0] - a[0], b[1] - a[1])
            L = math.hypot(*u)
            if L < 1e-6:
                continue
            u = (u[0] / L, u[1] / L)
            nrm = (-u[1], u[0])
            # quota dal lato basso (i pendini stanno sopra), a sinistra per i tratti verticali
            if (abs(u[0]) < 0.05 and nrm[0] > 0) or (abs(u[0]) >= 0.05 and nrm[1] > 0):
                nrm = (-nrm[0], -nrm[1])
            off = 9.0
            pa = (a[0] + nrm[0] * off, a[1] + nrm[1] * off)
            pb = (b[0] + nrm[0] * off, b[1] + nrm[1] * off)
            S.line(pa, pb, 0.18)
            for p0, p1 in ((a, pa), (b, pb)):
                S.line((p0[0] + nrm[0] * 1.5, p0[1] + nrm[1] * 1.5), (p1[0] + nrm[0] * 1.5, p1[1] + nrm[1] * 1.5), 0.18)
                S.line((p1[0] - (u[0] + nrm[0]) * 1.2, p1[1] - (u[1] + nrm[1]) * 1.2), (p1[0] + (u[0] + nrm[0]) * 1.2, p1[1] + (u[1] + nrm[1]) * 1.2), 0.3)
            ang = _readable(math.degrees(math.atan2(u[1], u[0])))
            up = (-math.sin(math.radians(ang)), math.cos(math.radians(ang)))
            d = 1.0 if up[0] * nrm[0] + up[1] * nrm[1] > 0 else 1.0 + 2.5
            mid = ((pa[0] + pb[0]) / 2 + nrm[0] * d, (pa[1] + pb[1]) / 2 + nrm[1] * d)
            S.text(mid, _fmt(_len(_sub(N[i + 1], N[i]))), 2.5, ang, "c")
        # quote di livello dove cambia la quota; partenza e arrivo con coordinate (una diramazione parte dalla madre: solo arrivo)
        for i, q in enumerate(Q):
            show = abs(N[i][2] - N[i - 1][2]) > 0.5 or (i + 1 < len(N) and abs(N[i + 1][2] - N[i][2]) > 0.5)
            if show and i not in (0, len(Q) - 1):
                S.text((q[0] - 2.5, q[1] + 2.5), _elev(N[i][2]), 2.2, 0, "r")
        ends = [(len(N) - 1, "srv_modeler.iso_fine")]
        if not line.get("ramo"):
            ends.insert(0, (0, "srv_modeler.iso_inizio"))
        for i, key in ends:
            q, p = Q[i], N[i]
            if len(rami) == 1:
                S.text((q[0] - 3, q[1] + 10.5), t(key), 2.2, 0, "r")
            S.text((q[0] - 3, q[1] + 6.5), _elev(p[2]), 2.2, 0, "r")
            S.text((q[0] - 3, q[1] + 3.0), f"E {_fmt(p[0])}  N {_fmt(p[1])}", 2.0, 0, "r")
        # componenti in linea e raccordi
        for c in line.get("componenti") or []:
            p, u = at(r, c["pos"])
            nrm = (-u[1], u[0])
            k = c.get("tipo")
            counts[(k, c.get("misura") or line.get("misura") or "")] = counts.get((k, c.get("misura") or line.get("misura") or ""), 0) + 1
            if k == "valve":
                s_ = 3.0
                a1 = (p[0] - u[0] * s_ + nrm[0] * s_ * 0.7, p[1] - u[1] * s_ + nrm[1] * s_ * 0.7)
                a2 = (p[0] - u[0] * s_ - nrm[0] * s_ * 0.7, p[1] - u[1] * s_ - nrm[1] * s_ * 0.7)
                b1 = (p[0] + u[0] * s_ + nrm[0] * s_ * 0.7, p[1] + u[1] * s_ + nrm[1] * s_ * 0.7)
                b2 = (p[0] + u[0] * s_ - nrm[0] * s_ * 0.7, p[1] + u[1] * s_ - nrm[1] * s_ * 0.7)
                S.poly([a1, a2, p], 0.3, True)
                S.poly([b1, b2, p], 0.3, True)
                S.line(p, (p[0] + nrm[0] * 5, p[1] + nrm[1] * 5), 0.3)  # volantino
                S.line((p[0] + nrm[0] * 5 - u[0] * 2, p[1] + nrm[1] * 5 - u[1] * 2), (p[0] + nrm[0] * 5 + u[0] * 2, p[1] + nrm[1] * 5 + u[1] * 2), 0.3)
            elif k in ("tee", "tee_rid"):
                S.circle(p, 1.3, 0.3, True)  # Tee: punto pieno sull'innesto
            elif k in ("riduzione", "riduzione_ecc"):
                q2 = (p[0] + u[0] * 3, p[1] + u[1] * 3)
                q1 = (p[0] - u[0] * 3, p[1] - u[1] * 3)
                S.poly([(q1[0] + nrm[0] * 2.6, q1[1] + nrm[1] * 2.6), (q1[0] - nrm[0] * 2.6, q1[1] - nrm[1] * 2.6),
                        (q2[0] - nrm[0] * 1.3, q2[1] - nrm[1] * 1.3), (q2[0] + nrm[0] * 1.3, q2[1] + nrm[1] * 1.3)], 0.3, False)
            else:
                gaps = (-0.8, 0.8) if k == "flanges" else (0.0,)
                for g in gaps:
                    q = (p[0] + u[0] * g, p[1] + u[1] * g)
                    S.line((q[0] - nrm[0] * 3, q[1] - nrm[1] * 3), (q[0] + nrm[0] * 3, q[1] + nrm[1] * 3), 0.5)
        for sp in line.get("supporti") or []:
            sup_all.append((r, sp))
    # supporti: triangolo sotto la linea (a pavimento) o sopra (pendino), numerati su tutto il foglio
    for j, (r, sp) in enumerate(sup_all, 1):
        p, _u = at(r, sp["pos"])
        if sp.get("tipo") == "hanger":
            S.line(p, (p[0], p[1] + 6), 0.25)
            S.line((p[0] - 2, p[1] + 6), (p[0] + 2, p[1] + 6), 0.4)
            S.text((p[0] + 1.2, p[1] + 7), f"S{j}", 1.8)
        else:
            S.poly([p, (p[0] - 2, p[1] - 3.5), (p[0] + 2, p[1] - 3.5)], 0.25, False)
            S.text((p[0] + 2.2, p[1] - 3.5), f"S{j}", 1.8)
    # freccia del nord (asse Y del modello)
    nc = (270.0, 210.0)
    nd = _proj([0, 1, 0])
    tip = (nc[0] + nd[0] * 12, nc[1] + nd[1] * 12)
    S.line(nc, tip, 0.35)
    nn = (-nd[1], nd[0])
    S.poly([tip, (tip[0] - nd[0] * 3 + nn[0] * 1.2, tip[1] - nd[1] * 3 + nn[1] * 1.2), (tip[0] - nd[0] * 3 - nn[0] * 1.2, tip[1] - nd[1] * 3 - nn[1] * 1.2)], 0.2, True)
    S.text((tip[0] - 3, tip[1] + 1.5), "N", 3.0)
    # cornice
    S.poly([(10, 10), (W - 10, 10), (W - 10, H - 10), (10, H - 10)], 0.5)
    # distinta della linea (a destra in alto): tubi per misura (dritti netti), curve per angolo e raggio, componenti, supporti
    X0, X1 = 295.0, W - 15
    y = H - 20
    S.text((X0, y), t("srv_modeler.iso_distinta"), 3.2)
    y -= 4
    S.line((X0, y), (X1, y), 0.3)
    rows, tubes, bends = [], {}, {}
    for r in rami:
        line, N = r["line"], r["N"]
        netto = sum(line.get("dritti") or []) - sum(float(c.get("lunghezza_fs") or 0) for c in line.get("componenti") or [])
        if not line.get("dritti"):
            netto = float(line.get("lunghezza") or 0)
        key = (line.get("misura") or "", line.get("materiale") or "")
        tubes[key] = tubes.get(key, 0.0) + netto
        for i in range(1, len(N) - 1):
            a, b = _sub(N[i], N[i - 1]), _sub(N[i + 1], N[i])
            la, lb = _len(a), _len(b)
            if la < 1e-9 or lb < 1e-9:
                continue
            ang = math.degrees(math.acos(max(-1.0, min(1.0, sum(a[k] * b[k] for k in range(3)) / la / lb))))
            if ang > 0.5:
                bk = (round(ang, 1), _fmt(line.get("raggio") or 0), line.get("misura") or "", line.get("materiale") or "")
                bends[bk] = bends.get(bk, 0) + 1
    for (mis, mat), L in tubes.items():
        rows.append((f"{t('srv_modeler.iso_tubo')} {mis}".strip(), mat, f"{L / 1000:.2f} m"))
    for (ang, rr, mis, mat), n in sorted(bends.items()):
        rows.append((f"{t('srv_modeler.iso_curva')} {ang:g}° R{rr} {mis}".strip(), mat, f"{n}"))
    pn = group[0].get("pn")
    for (k, mis), n in counts.items():
        rows.append((t("srv_modeler.iso_c_" + k), " · ".join(x for x in (mis, f"PN{_fmt(pn)}" if pn else "") if x), f"{n}"))
    for k in ("floor", "hanger"):
        n = sum(1 for _r, s_ in sup_all if s_.get("tipo") == k)
        if n:
            rows.append((t("srv_modeler.iso_s_" + k), "", f"{n}"))
    for i, (a, b, c) in enumerate(rows, 1):
        y -= 5.5
        S.text((X0, y), f"{i}", 2.2)
        S.text((X0 + 6, y), a[:34], 2.2)
        y -= 3.4
        if b:
            S.text((X0 + 6, y), b[:40], 1.8)
        S.text((X1, y + 3.4), c, 2.2, 0, "r")
        S.line((X0, y - 1.2), (X1, y - 1.2), 0.1)
    # cartiglio (in basso a destra): nessun nome di ditta
    first = group[0]
    cx0, cy0, cx1, cy1 = 295.0, 15.0, W - 15, 75.0
    S.poly([(cx0, cy0), (cx1, cy0), (cx1, cy1), (cx0, cy1)], 0.4)
    misure = list(dict.fromkeys(g.get("misura") or "" for g in group))
    fields = [
        (t("srv_modeler.iso_linea"), first.get("linea") or first.get("id") or ""),
        (t("srv_modeler.iso_misura"), " / ".join(m_ for m_ in misure if m_)),
        (t("srv_modeler.iso_classe"), first.get("spec") or ""),
        (t("srv_modeler.iso_pn"), f"PN{_fmt(first.get('pn') or 16)}" if first.get("pn") else ""),
        (t("srv_modeler.iso_modello"), nome or ""),
        (t("srv_modeler.iso_scala"), t("srv_modeler.iso_non_in_scala")),
        (t("srv_modeler.iso_data"), datetime.date.today().isoformat()),
        (t("srv_modeler.iso_foglio"), f"{n_sheet} / {tot}"),
    ]
    rh = (cy1 - cy0) / len(fields)
    for i, (k, v) in enumerate(fields):
        yy = cy1 - rh * (i + 1)
        if i:
            S.line((cx0, yy + rh), (cx1, yy + rh), 0.12)
        S.text((cx0 + 2, yy + rh * 0.3), k, 1.8)
        S.text((cx0 + 35, yy + rh * 0.3), str(v)[:42], 2.4)
    S.line((cx0 + 33, cy0), (cx0 + 33, cy1), 0.12)
    S.text((15, H - 18), t("srv_modeler.iso_titolo") + " - " + (first.get("linea") or first.get("id") or ""), 4.0)
    return S


def write_pdf(path, sheets):
    import fitz  # PyMuPDF

    k = 72 / 25.4
    doc = fitz.open()
    for S in sheets:
        pg = doc.new_page(width=W * k, height=H * k)

        def P(p):
            return fitz.Point(p[0] * k, (H - p[1]) * k)

        sh = pg.new_shape()
        for it in S.items:
            if it[0] == "l":
                sh.draw_line(P(it[1]), P(it[2]))
                sh.finish(color=(0, 0, 0), width=it[3] * k)
            elif it[0] == "p":
                pts = [P(p) for p in it[1]] + ([P(it[1][0])] if it[4] else [])
                sh.draw_polyline(pts)
                sh.finish(color=(0, 0, 0), fill=(0, 0, 0) if it[3] else None, width=it[2] * k, closePath=it[4])
            elif it[0] == "c":
                sh.draw_circle(P(it[1]), it[2] * k)
                sh.finish(color=(0, 0, 0), fill=(0, 0, 0) if it[4] else None, width=it[3] * k)
        sh.commit()
        for it in S.items:
            if it[0] != "t":
                continue
            _t, p, s, h, ang, align = it
            fs = h * k / 0.72  # altezza delle maiuscole circa 0,72 del corpo
            w = fitz.get_text_length(s, fontname="helv", fontsize=fs)
            dx = {"l": 0, "c": -w / 2, "r": -w}[align]
            a = math.radians(ang)
            base = P(p)
            pt = fitz.Point(base.x + dx * math.cos(a), base.y - dx * math.sin(a))
            pg.insert_text(pt, s, fontsize=fs, fontname="helv", morph=(pt, fitz.Matrix(ang)) if ang else None)
    doc.set_metadata({"title": t("srv_modeler.iso_titolo"), "creator": "MB Desk"})
    doc.save(path, garbage=3, deflate=True)
    doc.close()


def write_dxf(path, sheets):
    import ezdxf

    d = ezdxf.new("R2010", setup=True)
    d.header["$INSUNITS"] = 4
    for n, col in (("ISO-TUBO", 1), ("ISO-QUOTE", 3), ("ISO-TESTI", 7), ("ISO-SIMBOLI", 2), ("ISO-CORNICE", 8)):
        d.layers.add(n, color=col)
    LW = (5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100)
    lw = lambda mm: min(LW, key=lambda v: abs(v - mm * 100))  # noqa: E731
    msp = d.modelspace()
    for j, S in enumerate(sheets):
        ox = j * (W + 30)
        for it in S.items:
            if it[0] == "l":
                lay = "ISO-TUBO" if it[3] >= 0.6 else "ISO-QUOTE" if it[3] < 0.2 else "ISO-CORNICE"
                msp.add_line((it[1][0] + ox, it[1][1]), (it[2][0] + ox, it[2][1]), dxfattribs={"layer": lay, "lineweight": lw(it[3])})
            elif it[0] == "p":
                pts = [(p[0] + ox, p[1]) for p in it[1]]
                if it[3]:
                    h = msp.add_hatch(color=7, dxfattribs={"layer": "ISO-SIMBOLI"})
                    h.paths.add_polyline_path(pts, is_closed=True)
                msp.add_lwpolyline(pts, close=it[4], dxfattribs={"layer": "ISO-CORNICE" if it[2] >= 0.4 else "ISO-SIMBOLI", "lineweight": lw(it[2])})
            elif it[0] == "c":
                msp.add_circle((it[1][0] + ox, it[1][1]), it[2], dxfattribs={"layer": "ISO-TUBO"})
            elif it[0] == "t":
                _t, p, s, h, ang, align = it
                from ezdxf.enums import TextEntityAlignment as A
                tx = msp.add_text(s, height=h, rotation=ang, dxfattribs={"layer": "ISO-TESTI", "style": "OpenSans"})
                tx.set_placement((p[0] + ox, p[1]), align={"l": A.LEFT, "c": A.CENTER, "r": A.RIGHT}[align])
    d.saveas(path)


def make(path, data, fmt="pdf", update=None):
    lines = [ln for ln in data.get("linee") or [] if len(ln.get("nodi") or []) >= 2]
    if not lines:
        raise ValueError(t("srv_modeler.iso_nessuna_linea"))
    # tubazioni con lo stesso numero di linea (principale e diramazioni) sullo stesso foglio
    groups, by = [], {}
    for ln in lines:
        key = (ln.get("linea") or "").strip()
        if key and key in by:
            by[key].append(ln)
        else:
            g = [ln]
            groups.append(g)
            if key:
                by[key] = g
    sheets = [layout(g, data.get("nome") or "", i + 1, len(groups)) for i, g in enumerate(groups)]
    (write_dxf if fmt == "dxf" else write_pdf)(path, sheets)
    return {"path": path, "fogli": len(sheets)}
