"""Scansioni e immagini -> disegno (risultato APPROSSIMATO). Tutto scritto qui con numpy e Pillow (niente OpenCV, niente potrace).

1. Pulizia: scala di grigi, sfondo uniformato (divisione per lo sfondo stimato con un filtro di massimo su una copia ridotta),
   soglia di Otsu (o fissa), inversione automatica dei lucidi/cianografie (tratto chiaro su fondo scuro),
   raddrizzamento (angolo che rende piu' "a righe" la proiezione dei punti neri, +-6 gradi), rimozione delle macchie
   (componenti connesse piu' piccole di N pixel, anche i buchi bianchi nei tratti).
   Componenti connesse: corse orizzontali (run) unite tra righe vicine con searchsorted + propagazione del minimo.
2. Testi: OCR di Windows (pdfedit._ocr_png) sull'immagine pulita, anche ruotata di 90 gradi per le quote verticali;
   una parola si accetta solo se i pezzi di inchiostro che tocca stanno dentro il suo riquadro (cosi' i tratti attraversati
   da una linea o i retini non diventano testo); i pezzi riconosciuti si tolgono prima della vettorizzazione.
3. Vettorizzazione:
   - "linee d'asse": scheletro di Zhang-Suen (solo sui pixel di bordo, a ondate) + tolta la "scaletta" dei pixel
     ridondanti, poi catene tra estremi/incroci (incroci vicini uniti nel baricentro), rami corti tolti;
   - "solo contorni": bordi tra pixel (crack following) orientati, un anello per ogni contorno esterno o buco.
   Ogni catena: Douglas-Peucker, poi archi e cerchi (cerchio ai minimi quadrati sui pixel della catena), linee quasi
   orizzontali/verticali raddrizzate, segmenti allineati riuniti attraverso gli incroci.
Coordinate di uscita: pixel dell'immagine raddrizzata, y verso l'alto (formato di todrawing.py).
"""
import math

import numpy as np

from .i18n import t as tr


# ---------------------------------------------------------------- apertura
def open_image(path: str, page: int = 0, info_only: bool = False) -> dict:
    from . import misc
    from pathlib import Path
    Image = misc._pil()
    ext = Path(path).suffix.lower().lstrip(".")
    if ext in misc.RAW_EXTS:
        im = Image.open(misc.image_to_png(path)["path"])
        frames = 1
    else:
        im = Image.open(path)
        frames = getattr(im, "n_frames", 1) or 1
    dpi = None
    try:
        d = im.info.get("dpi")
        if d and d[0] and d[0] > 20:
            dpi = float(d[0])
    except Exception:  # noqa: BLE001
        pass
    pages = []
    if info_only:
        for i in range(min(frames, 200)):
            try:
                im.seek(i)
                pages.append({"w": im.width, "h": im.height})
            except Exception:  # noqa: BLE001
                break
        return {"pages": pages or [{"w": im.width, "h": im.height}], "dpi": dpi}
    if frames > 1:
        im.seek(max(0, min(page, frames - 1)))
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im.convert("RGBA"))
        im = bg
    if im.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        im = im.point(lambda v: v / 256 if v > 255 else v)
    g = im.convert("L")
    return {"img": g, "dpi": dpi, "pages": [{"w": g.width, "h": g.height}]}


# ---------------------------------------------------------------- pulizia
def _normalize(g):
    """Sfondo uniformato: grigio / sfondo locale (massimo su una copia ridotta 1/16, sfumato)."""
    from PIL import Image, ImageFilter
    small = g.reduce(16) if min(g.size) >= 64 else g
    bg = small.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(2)).resize(g.size, Image.BILINEAR)
    a = np.asarray(g, dtype=np.float32)
    b = np.maximum(np.asarray(bg, dtype=np.float32), 1)
    return np.clip(a / b * 255, 0, 255).astype(np.uint8)


def _otsu(a):
    h = np.bincount(a.ravel(), minlength=256).astype(np.float64)
    tot = h.sum()
    w = np.cumsum(h)
    mu = np.cumsum(h * np.arange(256))
    mt = mu[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        s = (mt * w - mu * tot) ** 2 / (w * (tot - w))
    s[~np.isfinite(s)] = 0
    return int(np.argmax(s))


def _skew(B, max_deg=6.0):
    """Angolo (gradi, antiorario nell'immagine) di cui ruotare per raddrizzare."""
    ys, xs = np.nonzero(B)
    if len(xs) < 500:
        return 0.0
    if len(xs) > 300000:
        sel = np.random.default_rng(1).choice(len(xs), 300000, replace=False)
        xs, ys = xs[sel], ys[sel]
    xs = xs.astype(np.float64)
    ys = ys.astype(np.float64)

    def score(deg):
        r = math.radians(deg)
        s = 0.0
        # righe orizzontali (proiezione su y) e colonne verticali (su x): entrambe aiutano nei disegni
        for p in (ys * math.cos(r) - xs * math.sin(r), xs * math.cos(r) + ys * math.sin(r)):
            q = np.round(p - p.min()).astype(np.int64)
            c = np.bincount(q).astype(np.float64)
            s += float((c * c).sum())
        return s

    best = max(np.arange(-max_deg, max_deg + 1e-9, 0.25), key=score)
    fine = max(np.arange(best - 0.3, best + 0.3 + 1e-9, 0.02), key=score)
    return float(fine)


def _runs(B):
    H, W = B.shape
    p = np.zeros((H, W + 2), np.int8)
    p[:, 1:-1] = B
    d = np.diff(p, axis=1)
    sr, sc = np.nonzero(d == 1)
    _, ec = np.nonzero(d == -1)
    return sr.astype(np.int64), sc.astype(np.int64), ec.astype(np.int64)


def components(B):
    """Componenti connesse (8-connessione) per corse. -> (corse, etichetta per corsa, area, riquadri [r0, r1, c0, c1])."""
    H, W = B.shape
    sr, sc, ec = _runs(B)
    n = len(sr)
    if n == 0:
        z = np.zeros(0, np.int64)
        return (sr, sc, ec), z, z, np.zeros((0, 4), np.int64)
    BIG = W + 4
    keyS = sr * BIG + sc
    keyE = sr * BIG + (ec - 1)
    prev = sr - 1
    lo = np.searchsorted(keyE, prev * BIG + sc - 1, "left")
    hi = np.searchsorted(keyS, prev * BIG + ec, "right")
    cnt = np.maximum(hi - lo, 0)
    tot = int(cnt.sum())
    lab = np.arange(n, dtype=np.int64)
    if tot:
        a = np.repeat(np.arange(n), cnt)
        b = np.repeat(lo, cnt) + (np.arange(tot) - np.repeat(np.cumsum(cnt) - cnt, cnt))
        for _ in range(200):
            la, lb = lab[a], lab[b]
            m = np.minimum(la, lb)
            if not ((la != m).any() or (lb != m).any()):
                break
            np.minimum.at(lab, a, m)
            np.minimum.at(lab, b, m)
            for _ in range(6):
                lab = lab[lab]
    _, inv = np.unique(lab, return_inverse=True)
    nc = int(inv.max()) + 1
    area = np.bincount(inv, weights=(ec - sc), minlength=nc).astype(np.int64)
    box = np.zeros((nc, 4), np.int64)
    box[:, 0] = H
    box[:, 2] = W
    np.minimum.at(box[:, 0], inv, sr)
    np.maximum.at(box[:, 1], inv, sr)
    np.minimum.at(box[:, 2], inv, sc)
    np.maximum.at(box[:, 3], inv, ec - 1)
    return (sr, sc, ec), inv, area, box


def paint(shape, runs, keep):
    H, W = shape
    sr, sc, ec = runs
    sr, sc, ec = sr[keep], sc[keep], ec[keep]
    D = np.zeros((H, W + 1), np.int32)
    np.add.at(D, (sr, sc), 1)
    np.add.at(D, (sr, ec), -1)
    return np.cumsum(D, axis=1)[:, :W] > 0


def despeckle(B, min_area):
    if min_area <= 0:
        return B
    runs, inv, area, _ = components(B)
    B = paint(B.shape, runs, area[inv] >= min_area) if len(inv) else B
    # buchi bianchi piccoli nei tratti
    runs, inv, area, box = components(~B)
    if len(inv):
        H, W = B.shape
        border = (box[:, 0] == 0) | (box[:, 1] == H - 1) | (box[:, 2] == 0) | (box[:, 3] == W - 1)
        holes = (area < min_area) & ~border
        if holes.any():
            B = B | paint(B.shape, runs, holes[inv])
    return B


def clean(g, opts):
    """Immagine in grigio (PIL) -> (nero = True, immagine raddrizzata in grigio, angolo)."""
    from PIL import Image
    a = _normalize(g) if opts.get("flatten", True) else np.asarray(g, dtype=np.uint8)
    th = opts.get("threshold", "auto")
    t = _otsu(a) if th in (None, "", "auto") else int(th)
    B = a < t
    if B.mean() > 0.5:  # tratto chiaro su fondo scuro: si inverte
        a = 255 - a
        t = 255 - t
        B = ~B
    ang = 0.0
    if opts.get("deskew", True):
        small = B
        f = max(1, int(max(B.shape) / 2500))
        if f > 1:
            small = B[::f, ::f]
        ang = _skew(small)
        if abs(ang) >= 0.05:
            im = Image.fromarray(a).rotate(ang, resample=Image.BILINEAR, expand=True, fillcolor=255)
            a = np.asarray(im, dtype=np.uint8)
            B = a < t
        else:
            ang = 0.0
    dpi_k = float(opts.get("_dpi") or 300) / 300
    sp = opts.get("speck", "auto")
    min_area = int(round(max(4, 16 * dpi_k * dpi_k))) if sp in (None, "", "auto") else int(sp)
    B = despeckle(B, min_area)
    return B, a, ang


# ---------------------------------------------------------------- scheletro
OFFS8 = None


def _offs(Wp):
    # P2..P9: N, NE, E, SE, S, SW, W, NW
    return np.array([-Wp, -Wp + 1, 1, Wp + 1, Wp, Wp - 1, -1, -Wp - 1], dtype=np.int64)


def _lut_simple():
    """Per ogni codice dei vicini (bit i = vicino i in ordine P2..P9): pixel ridondante della scaletta (togliendolo la
    connessione non cambia, non e' un estremo e ha due vicini 4-connessi ad angolo)."""
    lut = np.zeros(256, bool)
    for code in range(256):
        nb = [(code >> i) & 1 for i in range(8)]
        cnt = sum(nb)
        if cnt < 2:
            continue
        # componenti 8-connesse tra i vicini
        seen, comps = set(), 0
        for i in range(8):
            if not nb[i] or i in seen:
                continue
            comps += 1
            stack = [i]
            while stack:
                k = stack.pop()
                if k in seen:
                    continue
                seen.add(k)
                for j in range(8):
                    if nb[j] and j not in seen:
                        dd = min((j - k) % 8, (k - j) % 8)
                        if dd == 1 or (dd == 2 and k % 2 == 0 and j % 2 == 0):
                            stack.append(j)
        if comps != 1:
            continue
        if (nb[0] and nb[2]) or (nb[2] and nb[4]) or (nb[4] and nb[6]) or (nb[6] and nb[0]):
            lut[code] = True
    return lut


_LUT = None


def thin(B):
    """Scheletro di Zhang-Suen calcolato solo sui pixel che possono cambiare. -> array piatto con bordo di 1 pixel e larghezza Wp."""
    global _LUT
    H, W = B.shape
    Wp = W + 2
    I = np.zeros((H + 2, Wp), np.uint8)
    I[1:-1, 1:-1] = B
    I = I.ravel()
    offs = _offs(Wp)
    fg = np.flatnonzero(I)
    if fg.size == 0:
        return I, Wp
    nb = I[fg[None, :] + offs[:, None]]
    cand = fg[(nb == 0).any(0)]
    step, empty = 0, 0
    while cand.size and empty < 2:
        nb = I[cand[None, :] + offs[:, None]]
        Bc = nb.sum(0)
        A = ((nb == 0) & (np.roll(nb, -1, axis=0) == 1)).sum(0)
        P2, P4, P6, P8 = nb[0], nb[2], nb[4], nb[6]
        if step == 0:
            c = (P2 * P4 * P6 == 0) & (P4 * P6 * P8 == 0)
        else:
            c = (P2 * P4 * P8 == 0) & (P2 * P6 * P8 == 0)
        m = (Bc >= 2) & (Bc <= 6) & (A == 1) & c
        dele = cand[m]
        if dele.size == 0:
            empty += 1
        else:
            empty = 0
            I[dele] = 0
            nbrs = (dele[:, None] + offs[None, :]).ravel()
            nbrs = nbrs[I[nbrs] == 1]
            cand = np.unique(np.concatenate([cand[~m], nbrs]))
        step ^= 1
    # scaletta: pixel ridondanti tolti uno alla volta (pochi)
    if _LUT is None:
        _LUT = _lut_simple()
    pix = np.flatnonzero(I)
    nb = I[pix[None, :] + offs[:, None]]
    code = (nb.astype(np.int64) << np.arange(8)[:, None]).sum(0)
    for p in pix[_LUT[code]].tolist():
        c = 0
        for i in range(8):
            if I[p + offs[i]]:
                c |= 1 << i
        if _LUT[c]:
            I[p] = 0
    return I, Wp


def trace_skeleton(I, Wp):
    """Catene di pixel dello scheletro. -> lista di (indici piatti, estremo iniziale e finale sono incroci?)"""
    offs = _offs(Wp).tolist()
    pix = np.flatnonzero(I)
    if pix.size == 0:
        return [], {}
    nb = I[pix[None, :] + np.array(offs)[:, None]]
    deg = nb.sum(0)
    D = np.zeros(I.size, np.int8)
    D[pix] = deg
    S = bytearray(I.tobytes())
    Dg = bytearray((D.astype(np.int16) & 0xFF).astype(np.uint8).tobytes())
    visited = bytearray(I.size)
    nodes = pix[deg != 2].tolist()
    chains = []
    for n in nodes:
        for o in offs:
            q = n + o
            if not S[q] or visited[q]:
                continue
            if Dg[q] != 2:
                continue  # due nodi vicini: fanno parte dello stesso incrocio
            ch = [n, q]
            visited[q] = 1
            prev, cur = n, q
            while True:
                nxt = -1
                for o2 in offs:
                    r = cur + o2
                    if r != prev and S[r]:
                        nxt = r
                        break
                if nxt < 0:
                    break
                ch.append(nxt)
                if Dg[nxt] != 2:
                    break
                if visited[nxt]:
                    break
                visited[nxt] = 1
                prev, cur = cur, nxt
            chains.append(ch)
    # anelli senza nodi (cerchi, rettangoli chiusi)
    for p in pix[deg == 2].tolist():
        if visited[p]:
            continue
        ch = [p]
        visited[p] = 1
        prev, cur = -1, p
        while True:
            nxt = -1
            for o2 in offs:
                r = cur + o2
                if r != prev and S[r] and (not visited[r] or (r == p and len(ch) > 2)):
                    nxt = r
                    break
            if nxt < 0:
                break
            ch.append(nxt)
            if nxt == p:
                break
            visited[nxt] = 1
            prev, cur = cur, nxt
        if len(ch) > 3:
            chains.append(ch)
    # incroci: nodi con 3 o piu' vicini, uniti se si toccano -> baricentro
    junc = {}
    jn = set(pix[deg >= 3].tolist())
    for j in list(jn):
        if j in junc:
            continue
        group, stack = [], [j]
        while stack:
            k = stack.pop()
            if k in junc:
                continue
            junc[k] = None
            group.append(k)
            for o in offs:
                r = k + o
                if r in jn and r not in junc:
                    stack.append(r)
        ys = [g // Wp - 1 + 0.5 for g in group]
        xs = [g % Wp - 1 + 0.5 for g in group]
        c = (sum(xs) / len(xs), sum(ys) / len(ys))
        for g in group:
            junc[g] = c
    deg_of = {p: d for p, d in zip(pix.tolist(), deg.tolist())} if len(nodes) < 2_000_000 else None
    return chains, {"junc": junc, "deg": deg_of}


def trace_contours(B):
    """Contorni tra pixel (crack following). -> lista di anelli di vertici (x, y) agli angoli dei pixel, solo i punti d'angolo."""
    H, W = B.shape
    P = np.zeros((H + 2, W + 2), bool)
    P[1:-1, 1:-1] = B
    W1 = W + 1
    starts, ends, dirs = [], [], []
    # sopra vuoto: (x+1,y)->(x,y) dir 2; sotto: (x,y+1)->(x+1,y+1) dir 0; sinistra: (x,y)->(x,y+1) dir 1; destra: (x+1,y+1)->(x+1,y) dir 3
    for dy, dx, sx, sy, ex, ey, dcode in ((-1, 0, 1, 0, 0, 0, 2), (1, 0, 0, 1, 1, 1, 0), (0, -1, 0, 0, 0, 1, 1), (0, 1, 1, 1, 1, 0, 3)):
        m = P[1:-1, 1:-1] & ~P[1 + dy:H + 1 + dy, 1 + dx:W + 1 + dx]
        ys, xs = np.nonzero(m)
        starts.append((ys + sy) * W1 + xs + sx)
        ends.append((ys + ey) * W1 + xs + ex)
        dirs.append(np.full(len(xs), dcode, np.int8))
    st = np.concatenate(starts)
    en = np.concatenate(ends)
    dr = np.concatenate(dirs)
    if st.size == 0:
        return []
    order = np.argsort(st, kind="stable")
    st, en, dr = st[order], en[order], dr[order]
    first = {}
    stl, enl, drl = st.tolist(), en.tolist(), dr.tolist()
    for i, s in enumerate(stl):
        if s in first:
            first[s].append(i)
        else:
            first[s] = [i]
    used = bytearray(len(stl))
    loops = []
    for i0 in range(len(stl)):
        if used[i0]:
            continue
        pts = []
        i = i0
        pd = None
        while not used[i]:
            used[i] = 1
            d = drl[i]
            if d != pd:
                s = stl[i]
                pts.append((s % W1, s // W1))
            pd = d
            nx = first.get(enl[i])
            if not nx:
                break
            if len(nx) == 1:
                i = nx[0]
            else:  # due pixel che si toccano in diagonale: si gira sempre dallo stesso lato
                cand = [j for j in nx if not used[j]]
                if not cand:
                    break
                cand.sort(key=lambda j: (drl[j] - d) % 4 != 1)
                i = cand[0]
        if len(pts) >= 3:
            loops.append(pts)
    return loops


# ---------------------------------------------------------------- catene -> linee, archi, cerchi
def _dp(P, tol):
    """Douglas-Peucker: indici dei vertici tenuti."""
    n = len(P)
    if n <= 2:
        return list(range(n))
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = P[b] - P[a]
        L = math.hypot(seg[0], seg[1])
        Q = P[a + 1:b] - P[a]
        if L < 1e-9:
            d = np.hypot(Q[:, 0], Q[:, 1])
        else:
            d = np.abs(Q[:, 0] * seg[1] - Q[:, 1] * seg[0]) / L
        k = int(np.argmax(d))
        if d[k] > tol:
            m = a + 1 + k
            keep[m] = True
            stack.append((a, m))
            stack.append((m, b))
    return list(np.flatnonzero(keep))


def _densify(P, step=1.0):
    """Punti d'angolo dei contorni -> punti ogni `step` pixel (i cerchi si stimano sul contorno, non sui soli angoli)."""
    out = [P[:1]]
    for a, b in zip(P[:-1], P[1:]):
        L = math.hypot(*(b - a))
        n = max(1, int(L / step))
        t = (np.arange(1, n + 1) / n)[:, None]
        out.append(a + (b - a) * t)
    return np.vstack(out)


def _fit(P):
    from .pdfvec import fit_circle
    return fit_circle(P)


def _arc_ok(P, fc, tol):
    """Arco plausibile: scarto entro la tolleranza, freccia sensibilmente diversa da una retta, angoli monotoni."""
    cx, cy, r, res = fc
    if res > max(1.5 * tol, min(r * 0.015, 2.5 * tol)) or r < 2.5:
        return None
    a = np.unwrap(np.arctan2(P[:, 1] - cy, P[:, 0] - cx))
    da = np.diff(a)
    if len(da) == 0:
        return None
    ccw = da.sum() > 0
    if (da < -0.05).any() if ccw else (da > 0.05).any():
        return None
    sw = abs(a[-1] - a[0])
    chord = math.hypot(*(P[-1] - P[0]))
    sag = r - math.sqrt(max(0.0, r * r - (chord / 2) ** 2)) if sw <= math.pi else r + math.sqrt(max(0.0, r * r - (chord / 2) ** 2))
    if sag < max(2.5 * tol, 2.5) or sw < math.radians(15):
        return None
    return (cx, cy, r, ccw, math.degrees(sw), a[0], a[-1])


def fit_chain(P, closed, tol, arcs=True):
    """Punti (N x 2) -> primitive [("L", x1, y1, x2, y2) | ("A", cx, cy, r, a0, a1 antiorari) | ("C", cx, cy, r)]."""
    out = []
    n = len(P)
    if n < 2:
        return out
    span = float(np.ptp(P, axis=0).max()) if n else 0
    if closed and arcs and n >= 8:
        fc = _fit(P)
        if fc and fc[3] <= max(1.5 * tol, min(fc[2] * 0.02, 3 * tol)) and fc[2] > 2.0 and fc[2] < span:
            return [("C", fc[0], fc[1], fc[2])]
    idx = _dp(P, tol)
    k = 0
    m = len(idx)
    while k < m - 1:
        best = None
        if arcs:
            e = k + 2
            while e < m:
                Q = P[idx[k]:idx[e] + 1]
                fc = _fit(Q)
                ok = _arc_ok(Q, fc, tol) if fc else None
                if not ok:
                    if best is not None or e > k + 4:
                        break
                    e += 1
                    continue
                best = (e, ok)
                e += 1
        if best:
            e, (cx, cy, r, ccw, sw, a0, a1) = best
            if sw >= 345 and closed and k == 0 and e == m - 1:
                out.append(("C", cx, cy, r))
            else:
                d0, d1 = math.degrees(a0) % 360, math.degrees(a1) % 360
                out.append(("A", cx, cy, r, d0, d1) if ccw else ("A", cx, cy, r, d1, d0))
            k = e
        else:
            a, b = P[idx[k]], P[idx[k + 1]]
            out.append(("L", float(a[0]), float(a[1]), float(b[0]), float(b[1])))
            k += 1
    return out


def merge_arcs(prim, tol):
    """Archi dello stesso cerchio (spezzati dagli incroci con altre linee): uniti in un arco solo o in un cerchio."""
    arcs = [p for p in prim if p[0] == "A"]
    rest = [p for p in prim if p[0] != "A"]
    groups = []
    for a in sorted(arcs, key=lambda a: -a[3]):
        for g in groups:
            # vicino a uno qualsiasi dei pezzi del gruppo (i centri stimati su archi corti oscillano di qualche pixel)
            if any(math.hypot(a[1] - c[1], a[2] - c[2]) <= max(3 * tol, c[3] * 0.15) and abs(a[3] - c[3]) <= max(3 * tol, c[3] * 0.1) for c in g):
                g.append(a)
                break
        else:
            groups.append([a])
    out = rest
    circles = [p for p in rest if p[0] == "C"]
    for g in groups:
        if len(g) == 1:
            out.append(g[0])
            continue
        w = sum(((a[5] - a[4]) % 360) for a in g)
        cx = sum(a[1] * ((a[5] - a[4]) % 360) for a in g) / max(w, 1e-9)
        cy = sum(a[2] * ((a[5] - a[4]) % 360) for a in g) / max(w, 1e-9)
        r = sum(a[3] * ((a[5] - a[4]) % 360) for a in g) / max(w, 1e-9)
        # intervalli angolari coperti (passo di 1 grado), tollerando i buchi piccoli degli incroci
        cov = np.zeros(360, bool)
        for a in g:
            s0, sw = a[4], (a[5] - a[4]) % 360
            cov[(np.arange(int(math.floor(s0)), int(math.ceil(s0 + sw)) + 1) % 360)] = True
        gap_max = max(4, int(math.degrees((6 * tol) / max(r, 1))) + 2)
        idx = np.flatnonzero(~cov)
        filled = cov.copy()
        if idx.size:
            # buchi corti (sotto gap_max gradi) si chiudono
            runs, start = [], idx[0]
            for i0, i1 in zip(idx, list(idx[1:]) + [None]):
                if i1 is None or i1 != i0 + 1:
                    runs.append((start, i0))
                    start = i1
            if len(runs) > 1 and runs[0][0] == 0 and runs[-1][1] == 359:
                runs = [(runs[-1][0] - 360, runs[0][1])] + runs[1:-1]
            for a0, a1 in runs:
                if a1 - a0 + 1 <= gap_max:
                    filled[np.arange(a0, a1 + 1) % 360] = True
        # oltre 300 gradi coperti = cerchio attraversato da altre linee (pilastri sugli assi, fori con le croci di centro)
        if filled.all() or filled.sum() >= 300:
            if not any(math.hypot(c[1] - cx, c[2] - cy) < 2 * tol and abs(c[3] - r) < 2 * tol for c in circles):
                out.append(("C", cx, cy, r))
            continue
        # uno o piu' archi continui
        free = np.flatnonzero(~filled)
        startdeg = int(free[0])
        k = 0
        cur = None
        for step in range(1, 361):
            d = (startdeg + step) % 360
            if filled[d]:
                if cur is None:
                    cur = d
                k += 1
            elif cur is not None:
                out.append(("A", cx, cy, r, float(cur), float((cur + k) % 360)))
                cur, k = None, 0
        if cur is not None:
            out.append(("A", cx, cy, r, float(cur), float((cur + k) % 360)))
    return out


def _ortho(lines, deg=0.8):
    """Linee quasi orizzontali/verticali -> esatte (rotazione attorno al punto medio)."""
    out = []
    for x1, y1, x2, y2 in lines:
        a = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180
        if min(a, 180 - a) < deg:
            ym = (y1 + y2) / 2
            y1 = y2 = ym
        elif abs(a - 90) < deg:
            xm = (x1 + x2) / 2
            x1 = x2 = xm
        out.append((x1, y1, x2, y2))
    return out


def merge_lines(lines, tol, ang_deg=2.0):
    """Segmenti con un estremo in comune e allineati -> un segmento solo (anche attraverso gli incroci)."""
    lines = [list(l) for l in lines if math.hypot(l[2] - l[0], l[3] - l[1]) > 1e-6]
    q = max(tol * 2, 1.0)

    def key(x, y):
        return (round(x / q), round(y / q))

    alive = [True] * len(lines)
    idx = {}
    for i, l in enumerate(lines):
        for e in (0, 1):
            idx.setdefault(key(l[2 * e], l[2 * e + 1]), []).append(i)
    changed = True
    rounds = 0
    while changed and rounds < 6:
        changed = False
        rounds += 1
        for i in range(len(lines)):
            if not alive[i]:
                continue
            for e in (0, 1):
                l = lines[i]
                px, py = l[2 * e], l[2 * e + 1]
                kx, ky = key(px, py)
                cands = []
                for ddx in (-1, 0, 1):
                    for ddy in (-1, 0, 1):
                        cands += idx.get((kx + ddx, ky + ddy), [])
                for j in cands:
                    if j == i or not alive[j]:
                        continue
                    m = lines[j]
                    for f in (0, 1):
                        qx, qy = m[2 * f], m[2 * f + 1]
                        if math.hypot(qx - px, qy - py) > q:
                            continue
                        # direzioni: da estremo comune verso l'altro estremo, devono essere opposte
                        ax, ay = l[2 * (1 - e)] - px, l[2 * (1 - e) + 1] - py
                        bx, by = m[2 * (1 - f)] - qx, m[2 * (1 - f) + 1] - qy
                        la, lb = math.hypot(ax, ay), math.hypot(bx, by)
                        if la < 1e-9 or lb < 1e-9:
                            continue
                        cos = (ax * bx + ay * by) / (la * lb)
                        if cos > -math.cos(math.radians(ang_deg)):
                            continue
                        A = (l[2 * (1 - e)], l[2 * (1 - e) + 1])
                        Bp = (m[2 * (1 - f)], m[2 * (1 - f) + 1])
                        L = math.hypot(Bp[0] - A[0], Bp[1] - A[1])
                        dmid = abs((Bp[0] - A[0]) * (A[1] - py) - (A[0] - px) * (Bp[1] - A[1])) / max(L, 1e-9)
                        if dmid > tol:
                            continue
                        lines[i] = [A[0], A[1], Bp[0], Bp[1]]
                        alive[j] = False
                        for g in (0, 1):
                            idx.setdefault(key(lines[i][2 * g], lines[i][2 * g + 1]), []).append(i)
                        changed = True
                        break
                    if not alive[j]:
                        break
    return [tuple(l) for l, a in zip(lines, alive) if a]


# ---------------------------------------------------------------- OCR
def ocr_words(B, vertical=True):
    """Parole (testo, x0, y0, x1, y1 in pixel dell'immagine, rotazione 0/90)."""
    from PIL import Image
    from .pdfedit import _ocr_png
    import io
    H, W = B.shape
    res = []
    for rot in ((0, 90) if vertical else (0,)):
        arr = np.where(B, 0, 255).astype(np.uint8)
        im = Image.fromarray(arr)
        if rot == 90:
            im = im.transpose(Image.ROTATE_270)  # 90 gradi in senso orario: i testi verticali (letti dal basso) diventano orizzontali
        z = min(1.0, 9990 / max(im.size))
        if z < 1:
            im = im.resize((int(im.width * z), int(im.height * z)), Image.BILINEAR)
        buf = io.BytesIO()
        im.save(buf, "PNG")
        try:
            lines = _ocr_png(buf.getvalue())
        except Exception:  # noqa: BLE001
            continue
        for line in lines:
            for w in line:
                text, x, y, ww, hh = w[0], w[1] / z, w[2] / z, w[3] / z, w[4] / z
                if rot == 0:
                    res.append((text, x, y, x + ww, y + hh, 0, len(res)))
                else:
                    # (x', y') nell'immagine ruotata -> originale: x = y', y = H - 1 - x'
                    res.append((text, y, H - (x + ww), y + hh, H - x, 90, len(res)))
    return res


JUNK = set("|-_—–/\\.,:;'\"`~^*+=()[]{}<>!?°")


def accept_words(words, box, area, B):
    """Parole credibili e componenti da togliere. Una parola vale se i pezzi d'inchiostro che tocca le stanno dentro."""
    H, W = B.shape
    keep, remove = [], np.zeros(len(area), bool)
    taken = []
    # altezza tipica dei testi (parole di almeno 3 caratteri): le "parole" di 1-2 caratteri molto piu' grandi o piccole
    # sono quasi sempre cerchi letti come "O"/"0", trattini o puntini
    hs = sorted(w[4] - w[2] if w[5] == 0 else w[3] - w[1] for w in words if len(w[0].strip()) >= 3)
    hmed = hs[len(hs) // 2] if hs else None
    for w in sorted(words, key=lambda w: (w[5], w[6])):
        text = w[0].strip().replace("\ufffd", "?")
        if not text or all(c in JUNK for c in text):
            continue
        x0, y0, x1, y1 = w[1], w[2], w[3], w[4]
        bw, bh = x1 - x0, y1 - y0
        th = bh if w[5] == 0 else bw
        if len(text) <= 2 and hmed and th > 1.6 * hmed:
            continue
        if len(text) == 1 and text in "oO0" and 0.8 < bw / max(bh, 1) < 1.25:
            continue  # cerchietto
        if bw < 2 or bh < 4 or bh > H * 0.2:
            continue
        if any(not (x1 < a[0] or x0 > a[2] or y1 < a[1] or y0 > a[3]) for a in taken):
            continue  # gia' letta nell'altro verso
        m = max(2.0, 0.15 * min(bw, bh))
        X0, Y0, X1, Y1 = x0 - m, y0 - m, x1 + m, y1 + m
        # componenti che toccano il riquadro
        # box = [x0, y0, x1, y1] delle componenti
        touch = (box[:, 0] <= X1) & (box[:, 2] >= X0) & (box[:, 1] <= Y1) & (box[:, 3] >= Y0)
        ids = np.flatnonzero(touch)
        if ids.size == 0:
            continue
        inside = (box[ids, 0] >= X0) & (box[ids, 2] <= X1) & (box[ids, 1] >= Y0) & (box[ids, 3] <= Y1)
        ink_in = int(area[ids][inside].sum())
        # inchiostro di altri pezzi (linee che attraversano, retini) contato sui pixel veri del riquadro, non sui riquadri
        # delle componenti: un muro lungo ha un riquadro enorme ma tocca la parola solo se ci passa sopra
        ya, yb = max(0, int(Y0)), min(H, int(math.ceil(Y1)) + 1)
        xa, xb = max(0, int(X0)), min(W, int(math.ceil(X1)) + 1)
        box_ink = int(B[ya:yb, xa:xb].sum())
        foreign = max(0, box_ink - ink_in)
        if ink_in == 0 or foreign > 0.25 * box_ink or inside.sum() < max(1, len(text.replace(" ", "")) * 0.4):
            continue
        keep.append((text,) + tuple(w[1:]))
        taken.append((x0, y0, x1, y1))
        remove[ids[inside]] = True
    return keep, remove


# ---------------------------------------------------------------- tutto insieme
def vectorize(img, opts: dict, update=None) -> dict:
    update = update or (lambda **k: None)
    from PIL import Image
    g = img
    mp = g.width * g.height
    if mp > 90e6:  # oltre 90 megapixel si lavora su una copia ridotta (la scala resta giusta: k tiene conto del rapporto)
        z = math.sqrt(90e6 / mp)
        g = g.resize((int(g.width * z), int(g.height * z)), Image.BILINEAR)
    else:
        z = 1.0
    update(progress=0.05, message=tr("srv_drawing.pulizia"))
    B, gray, ang = clean(g, opts)
    H, W = B.shape
    tol = float(opts.get("vtol") or max(1.0, (float(opts.get("_dpi") or 300) / 300) * 1.0))
    ents = []
    layers = {}
    LV = tr("srv_drawing.layer_vettori")
    LT = tr("srv_drawing.layer_testi_ocr")
    layers[LV] = {"c": None, "lw": -3}
    texts = 0
    if opts.get("ocr", True):
        update(progress=0.15, message=tr("srv_drawing.riconoscimento_testi"))
        runs, inv, area, box = components(B)
        # riquadri delle componenti in coordinate x/y: [r0, r1, c0, c1] -> [x0, y0, x1, y1]
        bxy = np.stack([box[:, 2], box[:, 0], box[:, 3] + 1, box[:, 1] + 1], axis=1) if len(box) else np.zeros((0, 4))
        words = ocr_words(B, vertical=opts.get("ocr_vertical", True))
        keep, remove = accept_words(words, bxy, area, B)
        if remove.any():
            B = paint(B.shape, runs, ~remove[inv])
        layers[LT] = {"c": 0x00A0FF, "lw": -3}
        for w in keep:
            text, x0, y0, x1, y1, rot = w[:6]
            if rot == 0:
                h = (y1 - y0) * 0.92
                ents.append({"t": "text", "p": [x0, H - y1], "h": h, "rot": 0, "s": text, "font": "Arial", "L": LT, "wbox": [x0, H - y1, x1, H - y0]})
            else:
                h = (x1 - x0) * 0.92
                ents.append({"t": "text", "p": [x1, H - y1], "h": h, "rot": 90, "s": text, "font": "Arial", "L": LT, "wbox": [x0, H - y1, x1, H - y0]})
            texts += 1
        ents = _join_words(ents)
    update(progress=0.35, message=tr("srv_drawing.vettorizzazione"))
    arcs = opts.get("arcs", True)
    prim = []
    if opts.get("vmode", "center") == "outline":
        loops = trace_contours(B)
        update(progress=0.7, message=tr("srv_drawing.riconoscimento_forme"))
        for lp in loops:
            P = np.asarray(lp, dtype=np.float64)
            if len(P) < 3 or np.ptp(P, axis=0).max() < max(6.0, 3 * tol):
                continue  # puntini
            P = _densify(np.vstack([P, P[:1]]))
            prim += fit_chain(P, True, tol, arcs)
    else:
        I, Wp = thin(B)
        update(progress=0.55, message=tr("srv_drawing.tracciamento"))
        chains, meta = trace_skeleton(I, Wp)
        junc = meta["junc"]
        sk = int(np.count_nonzero(I)) or 1
        thick = float(B.sum()) / sk
        spur = max(3.0, thick * 1.6)
        update(progress=0.7, message=tr("srv_drawing.riconoscimento_forme"))
        deg = meta["deg"] or {}
        for ch in chains:
            arr = np.asarray(ch, dtype=np.int64)
            ys = arr // Wp - 1 + 0.5
            xs = arr % Wp - 1 + 0.5
            P = np.stack([xs, ys], axis=1)
            closed = len(ch) > 3 and ch[0] == ch[-1]
            # estremi sugli incroci: si spostano nel baricentro dell'incrocio
            j0, j1 = junc.get(ch[0]), junc.get(ch[-1])
            if j0:
                P[0] = j0
            if j1:
                P[-1] = j1
            length = float(np.hypot(*np.diff(P, axis=0).T).sum()) if len(P) > 1 else 0
            end0, end1 = deg.get(ch[0], 2) == 1, deg.get(ch[-1], 2) == 1
            if (end0 != end1) and length < spur:
                continue  # rametto dello scheletro
            if end0 and end1 and length < spur * 0.6:
                continue
            prim += fit_chain(P, closed, tol, arcs)
    prim = merge_arcs(prim, tol)
    lines = [p[1:] for p in prim if p[0] == "L"]
    if opts.get("ortho", True):
        lines = _ortho(lines)
    lines = merge_lines(lines, tol)
    min_len = float(opts.get("min_len") or 0)
    for x1, y1, x2, y2 in lines:
        if math.hypot(x2 - x1, y2 - y1) < max(min_len, 0.5):
            continue
        ents.append({"t": "line", "p": [x1, H - y1, x2, H - y2], "L": LV})
    for p in prim:
        if p[0] == "A":
            _, cx, cy, r, a0, a1 = p
            # y verso l'alto: gli angoli si specchiano e il verso si inverte
            ents.append({"t": "arc", "c": [cx, H - cy], "r": r, "a": [(-a1) % 360, (-a0) % 360], "L": LV})
        elif p[0] == "C":
            ents.append({"t": "circle", "c": [p[1], H - p[2]], "r": p[3], "L": LV})
    if z != 1.0:  # copia ridotta: si torna ai pixel dell'immagine originale
        for e in ents:
            _scale(e, 1 / z)
    clean_im = Image.fromarray(np.where(B, 0, 255).astype(np.uint8))
    for e in ents:
        e.pop("wbox", None)
    return {"ents": ents, "layers": layers, "clean": clean_im if z == 1.0 else clean_im.resize(img.size), "skew": round(ang, 2),
            "texts": texts, "size": [int(round(W / z)), int(round(H / z))]}


def _join_words(ents):
    """Parole della stessa riga OCR (stessa rotazione, altezza e linea di base, vicine) -> un testo solo."""
    texts = [e for e in ents if e["t"] == "text"]
    other = [e for e in ents if e["t"] != "text"]
    texts.sort(key=lambda e: (e["rot"], round((e["p"][1] if e["rot"] == 0 else e["p"][0]) / max(e["h"] * 0.5, 1)), e["p"][0] if e["rot"] == 0 else e["p"][1]))
    out = []
    for e in texts:
        if out:
            p = out[-1]
            if p["rot"] == e["rot"] and abs(p["h"] - e["h"]) < 0.45 * max(p["h"], e["h"]):
                if e["rot"] == 0:
                    same = abs(p["p"][1] - e["p"][1]) < 0.35 * p["h"]
                    gap = e["wbox"][0] - p["wbox"][2]
                else:
                    same = abs(p["p"][0] - e["p"][0]) < 0.35 * p["h"]
                    gap = e["wbox"][1] - p["wbox"][3]
                if same and -0.2 * p["h"] < gap < 2.2 * p["h"]:
                    p["s"] += " " + e["s"]
                    p["wbox"] = [min(p["wbox"][0], e["wbox"][0]), min(p["wbox"][1], e["wbox"][1]), max(p["wbox"][2], e["wbox"][2]), max(p["wbox"][3], e["wbox"][3])]
                    p["h"] = min(p["h"], e["h"])  # accenti e discendenti allungano il riquadro della parola
                    continue
        out.append(dict(e))
    return other + out


def _scale(e, f):
    t = e["t"]
    if t == "line":
        e["p"] = [v * f for v in e["p"]]
    elif t in ("arc", "circle"):
        e["c"] = [v * f for v in e["c"]]
        e["r"] *= f
    elif t == "text":
        e["p"] = [v * f for v in e["p"]]
        e["h"] *= f
