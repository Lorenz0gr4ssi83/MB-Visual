"""Misure ed estrazioni di quantita' dai PDF (pannello "Misure" comune a PDF, CAD e 3D: ui/js/measure/).

Tutte le coordinate restituite sono nello spazio utente del PDF (punti, y verso l'alto), lo stesso di pdf.js
(viewport.convertToPdfPoint): p_pdf = p_mupdf * ~page.transformation_matrix.

- page_geometry: tracciati vettoriali della pagina per l'aggancio (estremi, medi, centri, intersezioni) e per la misura di
  un oggetto con un clic (lunghezza del tracciato, area dei contorni chiusi con i fori);
- scales: scale dichiarate (dizionari /VP /Measure scritti da Acrobat, Bluebeam o MB Desk) e "Scala 1:N" nei testi;
- texts / tables: elenco dei testi (quote e quote di livello riconosciute) e tabelle di testo (page.find_tables);
- lines: lunghezze e aree dei tracciati raggruppate per colore, spessore, tratteggio, layer (contenuto opzionale), riempimento;
- symbols / similar: forme vettoriali identiche (anche ruotate di 90 gradi) contate sulle pagine;
- write / read / strip: misure salvate come annotazioni con dizionario /Measure (Line, PolyLine, Polygon con /IT ...Dimension,
  visibili e misurabili in Acrobat) + etichette FreeText + allegato "misure.mbmis" con tutti i dati (nomi, voci, prezzi).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
from pathlib import Path

from .i18n import t

NM = "mbvmis-"          # prefisso del nome (/NM) delle annotazioni scritte da MB Desk
OURS = ("MB Desk", "MB Visual")  # nome dei /VP scritti dall'app (fino alla 1.6.5: "MB Visual")
ATTACH = "misure.mbmis"  # allegato con il documento delle misure
_cache: dict = {}
_lock = threading.Lock()
PT = 0.0254 / 72
UNITS = {"mm": 0.001, "cm": 0.01, "dm": 0.1, "m": 1, "km": 1000, "in": 0.0254, "ft": 0.3048, "yd": 0.9144, "mi": 1609.344}


def _open(path):
    import pymupdf
    return pymupdf.open(path)


def _key(path, *extra):
    st = os.stat(path)
    return (str(Path(path).resolve()), st.st_size, st.st_mtime_ns) + extra


def _cached(key, fn):
    with _lock:
        if key in _cache:
            return _cache[key]
    v = fn()
    with _lock:
        if len(_cache) > 40:
            _cache.pop(next(iter(_cache)))
        _cache[key] = v
    return v


def _hex(c):
    if not c:
        return None
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v * 255))) for v in c[:3])


def _bez(p0, p1, p2, p3, n=8):
    out = []
    for i in range(1, n + 1):
        u = i / n
        a, b, c, d = (1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def _subpaths(items, M):
    """Elementi di un tracciato di PyMuPDF -> contorni [(punti, chiuso)] nello spazio del PDF, curve campionate."""
    subs, cur = [], None
    tp = lambda p: tuple(p * M)  # noqa: E731
    for it in items:
        k = it[0]
        if k == "re" or k == "qu":
            q = it[1].quad if k == "re" else it[1]
            pts = [tp(q.ul), tp(q.ur), tp(q.lr), tp(q.ll)]
            subs.append([pts, True])
            cur = None
            continue
        a = tp(it[1])
        if cur is None or math.hypot(cur[0][-1][0] - a[0], cur[0][-1][1] - a[1]) > 0.01:
            cur = [[a], False]
            subs.append(cur)
        if k == "l":
            cur[0].append(tp(it[2]))
        elif k == "c":
            cur[0].extend(_bez(a, tp(it[2]), tp(it[3]), tp(it[4])))
    for s in subs:
        P = s[0]
        if not s[1] and len(P) > 2 and math.hypot(P[0][0] - P[-1][0], P[0][1] - P[-1][1]) < 0.01:
            s[1] = True
            P.pop()
    return subs


def _circles(items, M):
    """Cerchi disegnati con 4 curve di Bezier consecutive (anche dentro un tracciato con altri elementi): [(cx, cy, r)]."""
    out, i = [], 0
    while i + 3 < len(items):
        grp = items[i:i + 4]
        if all(g[0] == "c" for g in grp) and abs(grp[0][1].x - grp[3][4].x) < 0.01 and abs(grp[0][1].y - grp[3][4].y) < 0.01:
            pts = [tuple(g[1] * M) for g in grp]
            cx = sum(p[0] for p in pts) / 4
            cy = sum(p[1] for p in pts) / 4
            rs = [math.hypot(p[0] - cx, p[1] - cy) for p in pts]
            r = sum(rs) / 4
            mids = [_bez(tuple(g[1] * M), tuple(g[2] * M), tuple(g[3] * M), tuple(g[4] * M), 2)[0] for g in grp]
            if r > 0 and max(abs(x - r) for x in rs) <= r * 0.02 and max(abs(math.hypot(p[0] - cx, p[1] - cy) - r) for p in mids) <= r * 0.02:
                out.append((cx, cy, r))
                i += 4
                continue
        i += 1
    return out


def _shoelace(P):
    s = 0.0
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        s += a[0] * b[1] - b[0] * a[1]
    return s / 2


def _inside(x, y, P):
    ins = False
    j = len(P) - 1
    for i in range(len(P)):
        xi, yi = P[i]
        xj, yj = P[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-300) + xi:
            ins = not ins
        j = i
    return ins


def region_area(loops):
    """Area di una regione con fori: un contorno dentro un numero dispari di altri e' un foro."""
    L = [P for P in loops if len(P) >= 3]
    A = [abs(_shoelace(P)) for P in L]
    s = 0.0
    for i, P in enumerate(L):
        x, y = P[0]
        d = sum(1 for j, Q in enumerate(L) if j != i and A[j] > A[i] and _inside(x, y, Q))
        s += -A[i] if d % 2 else A[i]
    return max(0.0, s)


def _plen(P, closed):
    s = sum(math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) for i in range(1, len(P)))
    if closed and len(P) > 2:
        s += math.hypot(P[0][0] - P[-1][0], P[0][1] - P[-1][1])
    return s


def _drawings(path, pno):
    def load():
        doc = _open(path)
        try:
            page = doc[pno]
            M = ~page.transformation_matrix
            out = []
            for d in page.get_drawings():
                items = d.get("items") or []
                if not items:
                    continue
                subs = _subpaths(items, M)
                if not subs:
                    continue
                out.append({"subs": subs, "circ": _circles(items, M), "stroke": _hex(d.get("color")), "fill": _hex(d.get("fill")),
                            "w": round(d.get("width") or 0, 2), "dash": (d.get("dashes") or "").strip("[] 0") or "", "layer": d.get("layer") or "",
                            "eo": bool(d.get("even_odd")), "close": bool(d.get("closePath")), "type": d.get("type") or "s",
                            "rect": tuple(d["rect"] * M) if d.get("rect") is not None else None})
            mb = page.rect * M
            return {"paths": out, "box": [min(mb.x0, mb.x1), min(mb.y0, mb.y1), max(mb.x0, mb.x1), max(mb.y0, mb.y1)], "rot": page.rotation}
        finally:
            doc.close()
    return _cached(_key(path, "draw", pno), load)


def _r(v):
    return round(v, 3)


# ---------------------------------------------------------------- geometria per aggancio e oggetti
def page_geometry(path, pno, limit=300000):
    D = _drawings(path, pno)
    paths, nseg = [], 0
    page_area = (D["box"][2] - D["box"][0]) * (D["box"][3] - D["box"][1])
    for i, d in enumerate(D["paths"]):
        flat = [[_r(c) for p in P for c in p] for P, _ in d["subs"]]
        nseg += sum(len(f) // 2 for f in flat)
        if nseg > limit:
            return {"ok": True, "box": D["box"], "paths": paths, "troncato": True, "n": len(D["paths"])}
        # sfondi a tutta pagina: niente aggancio sui bordi del foglio bianco
        bg = d["fill"] in ("#ffffff", None) and not d["stroke"] and d["rect"] and abs((d["rect"][2] - d["rect"][0]) * (d["rect"][3] - d["rect"][1])) > page_area * 0.8
        if bg:
            continue
        paths.append({"s": flat, "c": [c for _, c in d["subs"]], "st": d["stroke"], "f": d["fill"], "w": d["w"], "lay": d["layer"],
                      "circ": [[_r(v) for v in c] for c in d["circ"]] or None, "i": i})
    return {"ok": True, "box": D["box"], "paths": paths, "troncato": False, "n": len(D["paths"])}


# ---------------------------------------------------------------- scale
SCALE_WORDS = re.compile(r"(scala|scale|ma(?:ß|ss)stab|[ée]chelle|escala|sc\.)", re.I)
SCALE_RE = re.compile(r"(?<![\d.,])1\s*[:/]\s*(\d{1,6}(?:[.,]\d+)?)(?!\d)")


def _vp_list(doc, page):
    """Riquadri /VP della pagina con la loro scala: [(bbox, k, unit, nome)]."""
    out = []
    try:
        kind, val = doc.xref_get_key(page.xref, "VP")
    except Exception:
        return out
    if kind == "null":
        return out
    refs = []
    if kind == "array":
        refs = re.findall(r"(\d+) 0 R", val)
        inline = not refs
    else:
        inline = True
    texts = []
    if refs:
        for r in refs:
            texts.append(doc.xref_object(int(r), compressed=False))
    elif inline:
        texts.append(val)
    for txt in texts:
        for vp in _split_dicts(txt):
            bb = re.search(r"/BBox\s*\[([^\]]+)\]", vp)
            if not bb:
                continue
            box = [float(v) for v in bb.group(1).split()[:4]]
            name = re.search(r"/Name\s*\(([^)]*)\)", vp)
            mt = re.search(r"/Measure\s+(\d+) 0 R", vp)
            mtxt = doc.xref_object(int(mt.group(1)), compressed=False) if mt else vp
            k = _parse_measure_text(doc, mtxt)
            if k:
                out.append(([min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])], k[0], k[1], name.group(1) if name else "", k[2]))
    return out


def _split_dicts(txt):
    """Dizionari di primo livello dentro un array PDF scritto come testo."""
    out, depth, start, i = [], 0, None, 0
    while i < len(txt):
        if txt.startswith("<<", i):
            if depth == 0:
                start = i
            depth += 1
            i += 2
            continue
        if txt.startswith(">>", i):
            depth -= 1
            i += 2
            if depth == 0 and start is not None:
                out.append(txt[start:i])
            continue
        i += 1
    if not out and "<<" in txt:
        out.append(txt)
    return out


def _parse_measure_text(doc, mtxt):
    """(k, unit, R) da un dizionario /Measure scritto come testo."""
    rr = re.search(r"/R\s*\(([^)]*)\)", mtxt)
    xm = re.search(r"/X\s*\[(.*?)\]\s*/", mtxt + "/", re.S) or re.search(r"/D\s*\[(.*?)\]", mtxt, re.S)
    if not xm:
        return None
    first = xm.group(1)
    ref = re.match(r"\s*(\d+) 0 R", first)
    ftxt = doc.xref_object(int(ref.group(1)), compressed=False) if ref else first
    c = re.search(r"/C\s+([-\d.eE]+)", ftxt)
    u = re.search(r"/U\s*\(([^)]*)\)", ftxt)
    if not c:
        return None
    unit = (u.group(1) if u else "m").strip().lower()
    unit = {"meter": "m", "metri": "m", "\"": "in", "'": "ft", "inch": "in", "feet": "ft"}.get(unit, unit)
    if unit not in UNITS:
        unit = "m"
    return float(c.group(1)), unit, rr.group(1) if rr else ""


def scales(path):
    """Scale trovate nel documento: [{page, box, k, unit, N, label, source}]."""
    doc = _open(path)
    out = []
    try:
        for pno, page in enumerate(doc):
            for box, k, unit, name, R in _vp_list(doc, page):
                N = k * UNITS.get(unit, 1) / PT
                mb = page.mediabox
                full = abs((box[2] - box[0]) - mb.width) < 2 and abs((box[3] - box[1]) - mb.height) < 2
                out.append({"page": pno, "box": None if full else box, "k": k, "unit": unit, "N": round(N, 3),
                            "label": (name + " · " if name and not name.startswith(OURS) else "") + ("1:%g" % round(N, 2)), "source": t("srv_measure.fonte_vp")})
            # testi: "Scala 1:100" (si preferiscono quelli con la parola scala e in basso a destra, nel cartiglio)
            W, H = page.rect.width, page.rect.height
            best = None
            for b in page.get_text("blocks"):
                txt = b[4] or ""
                for m in SCALE_RE.finditer(txt):
                    N = float(m.group(1).replace(",", "."))
                    if not (1 <= N <= 100000):
                        continue
                    strong = bool(SCALE_WORDS.search(txt[max(0, m.start() - 30):m.start() + 1]))
                    if not strong and not re.search(r"\b(1\s*[:/]\s*(?:1|2|5|10|20|25|50|100|200|250|500|1000|2000|5000|10000))\b", txt):
                        continue
                    score = (2 if strong else 0) + (1 if b[0] > W * 0.5 else 0) + (1 if b[1] > H * 0.6 else 0)
                    if best is None or score > best[0]:
                        best = (score, N, b)
            if best and best[0] >= 2:
                N = best[1]
                out.append({"page": pno, "box": None, "k": N * PT, "unit": "m", "N": N, "label": "1:%g" % N, "source": t("srv_measure.fonte_cartiglio")})
    finally:
        doc.close()
    # pagine senza scala propria: stessa scala dei testi se e' unica
    return {"ok": True, "scale": out}


# ---------------------------------------------------------------- testi, quote, tabelle
QUOTE_RE = re.compile(r"^[ØøR∅hH=:]*\s*[±+\-]?\d{1,6}(?:[.,]\d{1,3})?\s*(?:m|cm|mm|m²|mq|m2|°)?$")
LEVEL_RE = re.compile(r"^(?:[±+\-]\s*\d{1,4}(?:[.,]\d{1,3})?|q\.?\s*[±+\-]?\d)", re.I)


def texts(path, pages=None):
    doc = _open(path)
    rows = []
    try:
        for pno in pages if pages is not None else range(len(doc)):
            page = doc[pno]
            M = ~page.transformation_matrix
            for b in page.get_text("dict").get("blocks", []):
                for ln in b.get("lines", []):
                    s = "".join(sp.get("text", "") for sp in ln.get("spans", [])).strip()
                    if not s:
                        continue
                    r = page.rect.__class__(ln["bbox"]) * M
                    kind = "livello" if LEVEL_RE.match(s) and QUOTE_RE.match(s.replace(" ", "")) else "quota" if QUOTE_RE.match(s) else "testo"
                    sz = max((sp.get("size", 0) for sp in ln.get("spans", [])), default=0)
                    d = ln.get("dir", (1, 0))
                    rows.append({"page": pno, "text": s, "kind": kind, "box": [_r(min(r.x0, r.x1)), _r(min(r.y0, r.y1)), _r(max(r.x0, r.x1)), _r(max(r.y0, r.y1))],
                                 "size": round(sz, 1), "angle": round(math.degrees(math.atan2(-d[1], d[0])), 1)})
    finally:
        doc.close()
    return {"ok": True, "testi": rows}


def tables(path, pages=None):
    doc = _open(path)
    out = []
    try:
        for pno in pages if pages is not None else range(len(doc)):
            page = doc[pno]
            M = ~page.transformation_matrix
            try:
                found = page.find_tables()
            except Exception:
                continue
            for k, tb in enumerate(found.tables):
                try:
                    data = tb.extract()
                except Exception:
                    continue
                if not data or len(data) < 2:
                    continue
                r = page.rect.__class__(tb.bbox) * M
                head = []
                try:
                    head = [h or "" for h in tb.header.names] if tb.header and not tb.header.external else []
                except Exception:
                    head = []
                # testo di ogni cella letto nel suo riquadro (extract() a volte riordina male i caratteri, es. "20,00" -> "2000 ,")
                rows = [[(page.get_text("text", clip=c).replace("\n", " ").strip() if c else "") for c in row.cells] for row in tb.rows]
                if not rows:
                    rows = [[(c or "").replace("\n", " ").strip() for c in row] for row in data]
                if head and rows and rows[0] == [h.replace("\n", " ").strip() for h in head]:
                    rows = rows[1:]
                out.append({"page": pno, "n": k + 1, "box": [_r(min(r.x0, r.x1)), _r(min(r.y0, r.y1)), _r(max(r.x0, r.x1)), _r(max(r.y0, r.y1))],
                            "head": [h.replace("\n", " ").strip() for h in head] or ["%s %d" % (t("srv_measure.colonna"), i + 1) for i in range(len(rows[0]))], "rows": rows})
    finally:
        doc.close()
    return {"ok": True, "tabelle": out}


# ---------------------------------------------------------------- lunghezze e aree per stile / layer
def lines(path, pages=None, regions=None):
    """Lunghezze e aree dei tracciati raggruppate per pagina, regione (riquadro con scala propria) e stile.
    regions: [{id, page, box}] -> ogni tracciato va nella prima regione che contiene il suo centro."""
    doc = _open(path)
    n = len(doc)
    doc.close()
    regions = regions or []
    agg = {}
    for pno in pages if pages is not None else range(n):
        D = _drawings(path, pno)
        page_area = (D["box"][2] - D["box"][0]) * (D["box"][3] - D["box"][1])
        for d in D["paths"]:
            pts = [p for P, _ in d["subs"] for p in P]
            if not pts:
                continue
            x0 = min(p[0] for p in pts); x1 = max(p[0] for p in pts); y0 = min(p[1] for p in pts); y1 = max(p[1] for p in pts)
            if (x1 - x0) * (y1 - y0) > page_area * 0.8 and not d["stroke"]:
                continue  # sfondo del foglio
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            reg = next((r["id"] for r in regions if r.get("page") == pno and r["box"][0] <= cx <= r["box"][2] and r["box"][1] <= cy <= r["box"][3]), None)
            L = sum(_plen(P, c) for P, c in d["subs"]) if d["stroke"] else 0.0
            closed = [P for P, c in d["subs"] if c or d["fill"]]
            A = region_area(closed) if closed and (d["fill"] or all(c for _, c in d["subs"])) else None
            key = (pno, reg, d["stroke"], d["fill"], d["w"], d["dash"], d["layer"])
            a = agg.get(key)
            if not a:
                a = agg[key] = {"page": pno, "reg": reg, "at": [_r(cx), _r(cy)], "g": {"stroke": d["stroke"] or "", "fill": d["fill"] or "", "width": d["w"], "dash": d["dash"] or "", "layer": d["layer"] or "",
                                "style": "%s · %s pt%s" % (d["stroke"] or d["fill"] or "-", d["w"], " · " + d["dash"] if d["dash"] else "")}, "len": 0.0, "area": 0.0, "count": 0, "hasA": False}
            a["len"] += L
            if A is not None:
                a["area"] += A
                a["hasA"] = True
            a["count"] += 1
    recs = []
    for a in agg.values():
        recs.append({"page": a["page"], "at": a["at"], "g": a["g"], "len": round(a["len"], 4), "area": round(a["area"], 4) if a["hasA"] else None, "count": a["count"], "color": a["g"]["stroke"] or a["g"]["fill"]})
    return {"ok": True, "records": recs}


# ---------------------------------------------------------------- simboli uguali
def _sig(path_list, box):
    """Firma di un gruppo di tracciati: segmenti normalizzati (origine nell'angolo, 0,25 pt), uguale anche ruotato di 90 gradi."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    segs = []
    for d in path_list:
        for P, c in d["subs"]:
            Q = P + [P[0]] if c else P
            for i in range(1, len(Q)):
                segs.append(((Q[i - 1][0] - cx, Q[i - 1][1] - cy), (Q[i][0] - cx, Q[i][1] - cy)))
    best = None
    q = lambda v: round(v * 4)  # noqa: E731
    for rot in range(4):
        out = []
        for a, b in segs:
            pa, pb = a, b
            for _ in range(rot):
                pa, pb = (-pa[1], pa[0]), (-pb[1], pb[0])
            ta, tb = (q(pa[0]), q(pa[1])), (q(pb[0]), q(pb[1]))
            out.append(min((ta, tb), (tb, ta)))
        out.sort()
        h = hashlib.sha1(repr(out).encode()).hexdigest()
        if best is None or h < best:
            best = h
    return best, len(segs)


def _clusters(path, pno):
    def load():
        D = _drawings(path, pno)
        P = D["paths"]
        W = D["box"][2] - D["box"][0]
        H = D["box"][3] - D["box"][1]
        if len(P) > 25000:
            return {"too_many": True, "groups": []}
        # gruppi di tracciati vicini (riquadri che si toccano entro 1,5 pt), esclusi quelli grandi
        boxes = []
        for i, d in enumerate(P):
            pts = [p for S, _ in d["subs"] for p in S]
            bx = [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]
            if (bx[2] - bx[0]) > W * 0.12 or (bx[3] - bx[1]) > H * 0.12:
                continue
            boxes.append((bx, i))
        boxes.sort(key=lambda b: b[0][0])
        parent = list(range(len(boxes)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        tol = 1.5
        active = []
        for j, (b, _) in enumerate(boxes):
            active = [k for k in active if boxes[k][0][2] + tol >= b[0]]
            for k in active:
                c = boxes[k][0]
                if c[1] - tol <= b[3] and b[1] - tol <= c[3]:
                    parent[find(j)] = find(k)
            active.append(j)
        groups = {}
        for j, (b, i) in enumerate(boxes):
            groups.setdefault(find(j), []).append((b, i))
        out = []
        for members in groups.values():
            bx = [min(m[0][0] for m in members), min(m[0][1] for m in members), max(m[0][2] for m in members), max(m[0][3] for m in members)]
            if (bx[2] - bx[0]) > W * 0.15 or (bx[3] - bx[1]) > H * 0.15 or max(bx[2] - bx[0], bx[3] - bx[1]) < 2:
                continue
            sig, nseg = _sig([P[i] for _, i in members], bx)
            if nseg < 2:
                continue
            col = P[members[0][1]]["stroke"] or P[members[0][1]]["fill"]
            out.append({"box": [_r(v) for v in bx], "sig": sig, "n": nseg, "color": col, "layer": P[members[0][1]]["layer"]})
        return {"too_many": False, "groups": out}
    return _cached(_key(path, "clus", pno), load)


def symbols(path, pages=None, min_count=2):
    doc = _open(path)
    n = len(doc)
    doc.close()
    found, warn = {}, []
    for pno in pages if pages is not None else range(n):
        C = _clusters(path, pno)
        if C["too_many"]:
            warn.append(pno + 1)
            continue
        for g in C["groups"]:
            f = found.setdefault(g["sig"], {"sig": g["sig"], "n": g["n"], "color": g["color"], "layer": g["layer"], "size": [_r(g["box"][2] - g["box"][0]), _r(g["box"][3] - g["box"][1])], "at": []})
            f["at"].append([pno, _r((g["box"][0] + g["box"][2]) / 2), _r((g["box"][1] + g["box"][3]) / 2)])
    out = [f for f in found.values() if len(f["at"]) >= min_count]
    out.sort(key=lambda f: (-len(f["at"]), -f["n"]))
    return {"ok": True, "simboli": out[:300], "pagine_saltate": warn}


def similar(path, pno, point, all_pages=False):
    """Simboli identici a quello sotto il punto: centri [[page, x, y]] (il primo e' quello cliccato)."""
    C = _clusters(path, pno)
    x, y = point
    hit = None
    for g in C["groups"]:
        b = g["box"]
        if b[0] - 1 <= x <= b[2] + 1 and b[1] - 1 <= y <= b[3] + 1 and (hit is None or (b[2] - b[0]) * (b[3] - b[1]) < (hit["box"][2] - hit["box"][0]) * (hit["box"][3] - hit["box"][1])):
            hit = g
    if not hit:
        return {"ok": True, "punti": [], "troppi": C["too_many"]}
    doc = _open(path)
    n = len(doc)
    doc.close()
    pts = []
    for p in range(n) if all_pages else [pno]:
        for g in _clusters(path, p)["groups"]:
            if g["sig"] == hit["sig"]:
                pts.append([p, _r((g["box"][0] + g["box"][2]) / 2), _r((g["box"][1] + g["box"][3]) / 2)])
    return {"ok": True, "punti": pts, "box": hit["box"]}


# ---------------------------------------------------------------- scrittura / lettura delle misure nel PDF
def _measure_dict(k, unit, label):
    """Dizionario /Measure (ISO 32000 12.9): 1 punto = k unita'; distanze e aree nelle stesse unita'."""
    u2 = unit + "²"
    esc = lambda s: s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")  # noqa: E731
    R = "1 pt = %s %s" % (("%.8g" % k), unit)
    nf = lambda u, c: "<</Type/NumberFormat/U(%s)/C %s/D 100/F/D/RD(,)/RT()>>" % (esc(u), ("%.10g" % c))  # noqa: E731
    return "<</Type/Measure/Subtype/RL/R(%s)/X[%s]/D[%s]/A[%s]/T[%s]/S[%s]/O[0 0]%s>>" % (
        esc(R), nf(unit, k), nf(unit, 1), nf(u2, 1), nf("°", 1), nf("", 1), ("/MBVLabel(%s)" % esc(label)) if label else "")


def _scale_for(doc_m, page, pt):
    for s in doc_m.get("scales") or []:
        b = s.get("box")
        if b and s.get("page") == page and pt and b[0] <= pt[0] <= b[2] and b[1] <= pt[1] <= b[3]:
            return s
    for s in doc_m.get("scales") or []:
        if not s.get("box") and s.get("page") == page:
            return s
    for s in doc_m.get("scales") or []:
        if not s.get("box") and s.get("page") is None:
            return s
    return {"k": PT, "unit": "m", "label": ""}


def _drop_ours(page):
    """Toglie le annotazioni di MB Desk dalla pagina (cancellando una misura spariscono anche le sue etichette /IRT)."""
    xrefs = [a.xref for a in page.annots() or [] if (a.info.get("name") or "").startswith(NM)]
    n = 0
    for x in xrefs:
        try:
            a = page.load_annot(x)
        except Exception:
            a = None
        if a:
            page.delete_annot(a)
            n += 1
    return n


def strip(path, out=None):
    """Copia (o il file stesso) senza le annotazioni scritte da MB Desk: con il pannello aperto le disegna l'interfaccia."""
    doc = _open(path)
    n = 0
    try:
        for page in doc:
            n += _drop_ours(page)
        target = out or path
        tmp = str(target) + ".tmp"
        doc.save(tmp, garbage=1, deflate=True)
    finally:
        doc.close()
    os.replace(tmp, target)
    return n


def read(path):
    """Documento delle misure salvato nel PDF (allegato), annotazioni di misura di altri programmi, scale /VP."""
    doc = _open(path)
    res = {"ok": True, "doc": None, "importate": [], "nostre": 0}
    try:
        if ATTACH in (doc.embfile_names() or []):
            try:
                res["doc"] = json.loads(doc.embfile_get(ATTACH).decode("utf-8"))
            except Exception:
                res["doc"] = None
        for pno, page in enumerate(doc):
            M = ~page.transformation_matrix
            for a in page.annots() or []:
                nm = a.info.get("name") or ""
                if nm.startswith(NM):
                    res["nostre"] += 1
                    continue
                kind, it = doc.xref_get_key(a.xref, "IT")
                kind2, meas = doc.xref_get_key(a.xref, "Measure")
                if kind2 == "null" or not it:
                    continue
                txt = doc.xref_object(int(meas.split()[0]), compressed=False) if kind2 == "xref" else meas
                k = _parse_measure_text(doc, txt)
                if not k:
                    continue
                verts = a.vertices or []
                pts = [list(map(_r, tuple(pymupdf_point(v) * M))) for v in verts]
                typ = {"/LineDimension": "len", "/PolyLineDimension": "pline", "/PolygonDimension": "area"}.get(it)
                if not typ or len(pts) < 2:
                    continue
                col = a.colors.get("stroke")
                res["importate"].append({"type": typ, "page": pno, "pts": pts, "k": k[0], "unit": k[1], "R": k[2], "name": a.info.get("subject") or "",
                                         "note": a.info.get("content") or "", "color": _hex(col) or "#e8590c"})
    finally:
        doc.close()
    return res


def pymupdf_point(v):
    import pymupdf
    return pymupdf.Point(v)


def _fmt(v, d=2):
    s = ("%." + str(d) + "f") % v
    return s.replace(".", ",")


def write(path, mdoc, labels=None, author=""):
    """Scrive le misure nel PDF (sul file indicato): annotazioni con /Measure + etichette + allegato misure.mbmis + /VP.
    labels: {id: testo dell'etichetta come nell'interfaccia}."""
    import pymupdf
    labels = labels or {}
    doc = pymupdf.open(path)
    counts = {"annotazioni": 0}
    try:
        # via le misure scritte in precedenza
        for page in doc:
            _drop_ours(page)
        items = mdoc.get("items") or []
        TYPE = {"len": t("srv_measure.t_len"), "pline": t("srv_measure.t_pline"), "perim": t("srv_measure.t_perim"), "area": t("srv_measure.t_area"),
                "vol": t("srv_measure.t_vol"), "ang": t("srv_measure.t_ang"), "rad": t("srv_measure.t_rad"), "elev": t("srv_measure.t_elev"), "count": t("srv_measure.t_count")}
        for m in items:
            pno = m.get("page")
            P = m.get("pts") or []
            if pno is None or not P or pno >= len(doc) or m.get("type") not in TYPE:
                continue
            page = doc[pno]
            T = page.transformation_matrix
            pts = [pymupdf.Point(p[0], p[1]) * T for p in P]
            s = _scale_for(mdoc, pno, P[0])
            col = m.get("color") or "#e8590c"
            rgb = tuple(int(col[i:i + 2], 16) / 255 for i in (1, 3, 5)) if re.match(r"^#[0-9a-fA-F]{6}$", col) else (0.9, 0.35, 0.05)
            typ = m["type"]
            lab = labels.get(m.get("id"), "")
            name = m.get("name") or m.get("voce") or TYPE[typ]
            info = {"title": m.get("author") or author or "MB Desk", "subject": TYPE[typ], "content": (name + ": " if name != TYPE[typ] else "") + lab + ("\n" + m["note"] if m.get("note") else "")}
            made = []
            if typ == "len":
                a = page.add_line_annot(pts[0], pts[1])
                a.set_line_ends(pymupdf.PDF_ANNOT_LE_OPEN_ARROW, pymupdf.PDF_ANNOT_LE_OPEN_ARROW)
                made.append((a, "/LineDimension"))
            elif typ in ("pline", "ang"):
                made.append((page.add_polyline_annot(pts), "/PolyLineDimension"))
            elif typ == "perim":
                made.append((page.add_polyline_annot(pts + [pts[0]]), "/PolyLineDimension"))
            elif typ in ("area", "vol"):
                a = page.add_polygon_annot(pts)
                made.append((a, "/PolygonDimension"))
                for H in m.get("holes") or []:
                    hp = [pymupdf.Point(p[0], p[1]) * T for p in H]
                    if len(hp) >= 3:
                        made.append((page.add_polygon_annot(hp), None))
            elif typ == "rad" and len(pts) >= 3:
                c = _circ3(P[0], P[1], P[2])
                if c:
                    cc = pymupdf.Point(c[0], c[1]) * T
                    rr = pymupdf.Rect(cc.x - c[2], cc.y - c[2], cc.x + c[2], cc.y + c[2])
                    made.append((page.add_circle_annot(rr), None))
                    made.append((page.add_line_annot(cc, pts[0]), "/LineDimension"))
            elif typ == "elev":
                p = pts[0]
                made.append((page.add_polyline_annot([pymupdf.Point(p.x - 5, p.y - 8), pymupdf.Point(p.x + 5, p.y - 8), p, pymupdf.Point(p.x - 5, p.y - 8)]), None))
            elif typ == "count":
                for i, p in enumerate(pts[:5000]):
                    r = pymupdf.Rect(p.x - 4, p.y - 4, p.x + 4, p.y + 4)
                    sym = m.get("symbol") or "circle"
                    a = page.add_circle_annot(r) if sym in ("circle", "star", "check") else page.add_rect_annot(r)
                    made.append((a, None))
            for k, (a, it) in enumerate(made):
                hole = typ in ("area", "vol") and k > 0
                # i fori coprono il riempimento (un poligono PDF non puo' avere fori)
                a.set_colors(stroke=rgb, fill=(1, 1, 1) if hole else rgb if typ in ("area", "vol") and k == 0 or typ == "count" else None)
                a.set_border(width=1.2)
                if typ in ("area", "vol") and k == 0:
                    a.set_opacity(0.45)
                a.set_info(info)
                a.set_name(NM + str(m.get("id")) + ("" if k == 0 else "-%d" % k))
                a.update()
                if it:
                    doc.xref_set_key(a.xref, "IT", it)
                    doc.xref_set_key(a.xref, "Measure", _measure_dict(float(s.get("k") or PT), s.get("unit") or "m", s.get("label") or ""))
                counts["annotazioni"] += 1
            # etichetta visibile sul foglio (Acrobat non disegna il valore delle misure scritte da altri programmi)
            if lab and made:
                if typ == "count":
                    anchor = pts[-1]
                elif typ in ("area", "vol", "perim"):
                    anchor = pymupdf.Point(sum(p.x for p in pts) / len(pts), sum(p.y for p in pts) / len(pts))
                elif typ == "ang":
                    anchor = pts[1]
                elif len(pts) > 1:  # meta' del tratto piu' lungo
                    i = max(range(1, len(pts)), key=lambda j: abs(pts[j] - pts[j - 1]))
                    anchor = pymupdf.Point((pts[i].x + pts[i - 1].x) / 2, (pts[i].y + pts[i - 1].y) / 2)
                else:
                    anchor = pts[0]
                text = (name + (" " if typ == "count" else ": ") if name != TYPE[typ] else "") + lab
                w = 8 + pymupdf.get_text_length(text, "helv", 7.5)
                rr = pymupdf.Rect(anchor.x - w / 2, anchor.y - 15, anchor.x + w / 2, anchor.y - 3) * page.derotation_matrix if page.rotation else pymupdf.Rect(anchor.x - w / 2, anchor.y - 15, anchor.x + w / 2, anchor.y - 3)
                ft = page.add_freetext_annot(rr, text, fontsize=7.5, fontname="helv", text_color=(1, 1, 1), fill_color=(0.12, 0.13, 0.14), rotate=page.rotation, align=1)
                ft.set_info({**info, "content": text, "subject": t("srv_measure.etichetta")})
                ft.set_name(NM + "l-" + str(m.get("id")))
                ft.update()
                doc.xref_set_key(ft.xref, "IRT", "%d 0 R" % made[0][0].xref)
                doc.xref_set_key(ft.xref, "RT", "/Group")
                counts["annotazioni"] += 1
        # riquadri di misura /VP (pagine e riquadri con scala): lo strumento Misura di Acrobat li usa
        for pno, page in enumerate(doc):
            vps = []
            mb = page.mediabox
            for s in mdoc.get("scales") or []:
                if s.get("page") not in (None, pno):
                    continue
                box = s.get("box") or [mb.x0, mb.y0, mb.x1, mb.y1]
                vps.append("<</Type/Viewport/BBox[%s]/Name(MB Desk %s)/Measure %s>>" % (" ".join("%.3f" % v for v in box), s.get("label", "").replace("(", "").replace(")", ""),
                                                                                       _measure_dict(float(s.get("k") or PT), s.get("unit") or "m", s.get("label") or "")))
            # i /VP di altri programmi restano; quelli di MB Desk si riscrivono
            kind, val = doc.xref_get_key(page.xref, "VP")
            keep = [d for d in _split_dicts(val) if not any(o in d for o in OURS)] if kind == "array" and "R" not in val.split() else []
            if vps or keep:
                doc.xref_set_key(page.xref, "VP", "[" + " ".join(keep + vps) + "]")
            elif kind != "null" and any(o in (val or "") for o in OURS):
                doc.xref_set_key(page.xref, "VP", "null")
        # allegato con tutti i dati (voci, prezzi, note, scale)
        data = json.dumps(mdoc, ensure_ascii=False).encode("utf-8")
        if ATTACH in (doc.embfile_names() or []):
            doc.embfile_del(ATTACH)  # embfile_upd di PyMuPDF 2.0 non accetta bytes
        doc.embfile_add(ATTACH, data, filename=ATTACH, desc="MB Desk")
        tmp = path + ".mbmis.tmp"
        doc.save(tmp, garbage=1, deflate=True)
    finally:
        doc.close()
    os.replace(tmp, path)
    return {"ok": True, **counts}


def _circ3(A, B, C):
    ax, ay, bx, by, cx, cy = A[0], A[1], B[0], B[1], C[0], C[1]
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return None
    a2, b2, c2 = ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy
    ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
    uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
    return ux, uy, math.hypot(ax - ux, ay - uy)


# ---------------------------------------------------------------- ingresso unico dell'API (server.py api_measure)
def handle(op, path, body):
    b = body or {}
    if op == "pdf_page":
        return page_geometry(path, int(b.get("page", 0)))
    if op == "pdf_scales":
        return scales(path)
    if op == "pdf_texts":
        return texts(path, b.get("pages"))
    if op == "pdf_tables":
        return tables(path, b.get("pages"))
    if op == "pdf_lines":
        return lines(path, b.get("pages"), b.get("regions"))
    if op == "pdf_symbols":
        return symbols(path, b.get("pages"))
    if op == "pdf_similar":
        return similar(path, int(b.get("page", 0)), b["point"], bool(b.get("all")))
    if op == "pdf_read":
        return read(path)
    if op == "pdf_strip":
        from .paths import TEMP_DIR
        from . import pdfedit
        out = pdfedit.working_copy(path, TEMP_DIR / "pdf-modifica")
        n = strip(path, out)
        return {"ok": True, "path": out, "tolte": n}
    if op == "pdf_write":
        return write(path, b["doc"], b.get("labels"), b.get("author", ""))
    raise ValueError(t("srv_measure.operazione_sconosciuta", op))
