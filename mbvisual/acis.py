# Lettore del formato binario ShapeManager/ACIS ("ASM BinaryFile4" / "ACIS BinaryFile"), scritto da zero
# per MB Visual a partire dalla descrizione pubblica del formato SAT/SAB e dall'analisi dei file.
# Ogni record e' una sequenza di valori con un byte di tipo davanti; il record finisce con 0x11.
# Il risultato e' un elenco di Record (tipo, valori) con i puntatori come indici nell'elenco.
from __future__ import annotations

import struct

# tipi dei valori
INT, DOUBLE, STR, PTR, TRUE, FALSE = 0x04, 0x06, 0x07, 0x0C, 0x0A, 0x0B
NAME, NAME_EX, SUB_START, SUB_END, END = 0x0D, 0x0E, 0x0F, 0x10, 0x11
LSTR, POS, VEC, ENUM, DOUBLE2, POS2 = 0x12, 0x13, 0x14, 0x15, 0x17, 0x16


class Record:
    __slots__ = ("index", "type", "v")

    def __init__(self, index: int, type_: str, values: list):
        self.index = index
        self.type = type_
        self.v = values  # [(tag, valore)] senza i nomi del tipo

    def __repr__(self):
        return f"<{self.index} {self.type}>"


class AcisError(Exception):
    pass


def parse(data: bytes) -> tuple[dict, list[Record], list]:
    """(intestazione, record, sottotipi). sottotipi[i] = (record, posizione del valore SUB_START) per i "ref"."""
    if data.startswith(b"ASM BinaryFile4"):
        p = 15
    elif data.startswith(b"ACIS BinaryFile"):
        p = 15
    else:
        raise AcisError("dati ShapeManager non riconosciuti")
    version, n_rec, n_ent, flags = struct.unpack_from("<4i", data, p)
    p += 16
    n = len(data)
    unpack = struct.unpack_from

    def token():
        nonlocal p
        t = data[p]
        p += 1
        if t == INT or t == PTR or t == ENUM:
            v = unpack("<i", data, p)[0]
            p += 4
            return t, v
        if t == DOUBLE or t == DOUBLE2:
            v = unpack("<d", data, p)[0]
            p += 8
            return t, v
        if t == STR or t == NAME or t == NAME_EX:
            ln = data[p]
            v = data[p + 1:p + 1 + ln].decode("latin-1")
            p += 1 + ln
            return t, v
        if t == 0x08:
            ln = unpack("<H", data, p)[0]
            v = data[p + 2:p + 2 + ln].decode("latin-1")
            p += 2 + ln
            return STR, v
        if t == 0x09 or t == LSTR:
            ln = unpack("<i", data, p)[0]
            v = data[p + 4:p + 4 + ln].decode("latin-1")
            p += 4 + ln
            return STR, v
        if t == POS or t == VEC:
            v = unpack("<3d", data, p)
            p += 24
            return t, v
        if t == POS2:
            v = unpack("<2d", data, p)
            p += 16
            return t, v
        if t in (TRUE, FALSE, SUB_START, SUB_END, END):
            return t, None
        raise AcisError(f"valore sconosciuto 0x{t:02x} alla posizione {p - 1}")

    header = {"version": version, "flags": flags}
    hv = []
    for _ in range(6):
        hv.append(token()[1])
    header.update(product=hv[0], asm=hv[1], date=hv[2], unit_mm=hv[3] or 1.0, resabs=hv[4], resnor=hv[5])

    records: list[Record] = []
    subtypes: list = []
    # ciclo scritto in linea (senza chiamate per ogni valore): i modelli grandi hanno milioni di valori
    ui = struct.Struct("<i").unpack_from
    ud = struct.Struct("<d").unpack_from
    u3 = struct.Struct("<3d").unpack_from
    u2 = struct.Struct("<2d").unpack_from
    uh = struct.Struct("<H").unpack_from
    while p < n:
        names: list[str] = []
        vals: list = []
        add = vals.append
        type_ = None
        has_sub = False
        try:
            while True:
                t = data[p]
                p += 1
                if t == PTR or t == INT or t == ENUM:
                    add((t, ui(data, p)[0]))
                    p += 4
                elif t == DOUBLE or t == DOUBLE2:
                    add((t, ud(data, p)[0]))
                    p += 8
                elif t == POS or t == VEC:
                    add((t, u3(data, p)))
                    p += 24
                elif t == END:
                    break
                elif t == TRUE or t == FALSE or t == SUB_END:
                    add((t, None))
                elif t == STR or t == NAME or t == NAME_EX:
                    ln = data[p]
                    v = data[p + 1:p + 1 + ln].decode("latin-1")
                    p += 1 + ln
                    if type_ is None and not vals and t != STR:
                        names.append(v)
                        if t == NAME:
                            type_ = "-".join(names)
                    else:
                        add((t, v))
                elif t == SUB_START:
                    has_sub = True
                    add((t, None))
                elif t == 0x08:
                    ln = uh(data, p)[0]
                    add((STR, data[p + 2:p + 2 + ln].decode("latin-1")))
                    p += 2 + ln
                elif t == 0x09 or t == LSTR:
                    ln = ui(data, p)[0]
                    add((STR, data[p + 4:p + 4 + ln].decode("latin-1")))
                    p += 4 + ln
                elif t == POS2:
                    add((t, u2(data, p)))
                    p += 16
                else:
                    raise AcisError(f"valore sconosciuto 0x{t:02x} alla posizione {p - 1}")
        except (AcisError, IndexError, struct.error):
            if records:
                break  # dati dopo la fine del modello (cronologia, blocchi Inventor)
            raise
        if type_ is None and not vals:
            continue
        type_ = type_ or ""
        if type_.startswith(("End-of-", "Begin-of-ASM-History", "Begin-of-ACIS-History")):
            break
        if not has_sub and type_.endswith("attrib"):
            vals = []  # attributi (nomi delle facce per Inventor): non servono alla geometria, si risparmia memoria
        r = Record(len(records), type_, vals)
        if has_sub:
            for k, (t, _v) in enumerate(vals):
                # ogni oggetto sottotipo riceve un numero in ordine di scrittura; i "{ ref n }" non contano
                if t == SUB_START and not (k + 1 < len(vals) and vals[k + 1][1] == "ref"):
                    subtypes.append((r, k))
        records.append(r)
    return header, records, subtypes


class Cursor:
    """Lettura in sequenza dei valori di un record (o di un sottotipo)."""

    def __init__(self, vals: list, pos: int = 0):
        self.v = vals
        self.i = pos

    def more(self):
        return self.i < len(self.v)

    def peek(self):
        return self.v[self.i][0] if self.i < len(self.v) else None

    def peekv(self):
        return self.v[self.i][1] if self.i < len(self.v) else None

    def next(self):
        t = self.v[self.i]
        self.i += 1
        return t

    def ptr(self):
        t, v = self.next()
        if t != PTR:
            raise AcisError(f"atteso un puntatore, trovato 0x{t:02x}")
        return v

    def int(self):
        t, v = self.next()
        if t not in (INT, ENUM):
            raise AcisError(f"atteso un intero, trovato 0x{t:02x}")
        return v

    def float(self):
        t, v = self.next()
        if t not in (DOUBLE, DOUBLE2):
            if t in (INT, ENUM):
                return float(v)
            raise AcisError(f"atteso un numero, trovato 0x{t:02x}")
        return v

    def vec(self):
        t, v = self.next()
        if t not in (POS, VEC):
            raise AcisError(f"atteso un vettore, trovato 0x{t:02x}")
        return v

    def bool(self):
        t, _ = self.next()
        if t == TRUE:
            return True
        if t == FALSE:
            return False
        raise AcisError(f"atteso un valore si'/no, trovato 0x{t:02x}")

    def interval(self):
        if self.bool():
            return self.float()
        return None

    def str(self):
        t, v = self.next()
        return v

    def skip_subtype(self):
        """Salta un blocco { ... } (il SUB_START e' gia' stato letto)."""
        depth = 1
        while depth:
            t, _ = self.next()
            if t == SUB_START:
                depth += 1
            elif t == SUB_END:
                depth -= 1


# ---------------------------------------------------------------- B-spline (bs3_curve / bs3_surface)

FORMS = ("nubs", "nurbs")


def read_bs3_curve(c: Cursor, dim: int = 3):
    """Curva B-spline dopo la parola nubs/nurbs (gia' letta in form). -> dict o None"""
    form = c.str()
    if form not in FORMS:
        return None
    rational = form == "nurbs"
    deg = c.int()
    closure = c.int()  # 0 aperta, 1 chiusa, 2 periodica
    nk = c.int()
    knots, mults = [], []
    for _ in range(nk):
        knots.append(c.float())
        mults.append(c.int())
    ncp = sum(mults) - deg + 1
    pts, w = [], []
    for _ in range(ncp):
        pts.append(tuple(c.float() for _ in range(dim)))
        if rational:
            w.append(c.float())
    return {"deg": deg, "closure": closure, "knots": knots, "mults": mults, "pts": pts, "w": w or None}


def read_bs3_surface(c: Cursor):
    form = c.str()
    if form not in FORMS:
        return None
    du, dv = c.int(), c.int()
    rat = c.str() if c.peek() in (NAME, STR) else ("both" if form == "nurbs" else "none")
    cu, cv = c.int(), c.int()  # chiusura
    _su, _sv = c.int(), c.int()  # singolarita'
    nu, nv = c.int(), c.int()
    ku, mu, kv, mv = [], [], [], []
    for _ in range(nu):
        ku.append(c.float())
        mu.append(c.int())
    for _ in range(nv):
        kv.append(c.float())
        mv.append(c.int())
    ncu = sum(mu) - du + 1
    ncv = sum(mv) - dv + 1
    rational = rat != "none" and form == "nurbs"
    # i punti sono scritti con u che varia piu' in fretta (verificato sulla regolarita' della griglia)
    pts = [[None] * ncv for _ in range(ncu)]
    w = [[1.0] * ncv for _ in range(ncu)]
    for j in range(ncv):
        for i in range(ncu):
            pts[i][j] = (c.float(), c.float(), c.float())
            if rational:
                w[i][j] = c.float()
    return {"du": du, "dv": dv, "cu": cu, "cv": cv, "ku": ku, "mu": mu, "kv": kv, "mv": mv, "pts": pts,
            "w": w if rational else None}


def find_bs3(vals: list, start: int, surface: bool):
    """Cerca, nel blocco { } che inizia in start, la prima B-spline del tipo voluto allo stesso livello.
    Le curve/superfici annidate (blocchi interni) si saltano: es. cyl_spl_sur contiene la curva di profilo
    prima dell'approssimazione della superficie."""
    depth = 0
    i = start
    n = len(vals)
    while i < n:
        t, v = vals[i]
        if t == SUB_START:
            depth += 1
        elif t == SUB_END:
            depth -= 1
            if depth <= 0:
                return None
        elif depth == 1 and t in (NAME, STR) and v in FORMS and i + 2 < n:
            t1, t2 = vals[i + 1][0], vals[i + 2][0]
            is_surf = t1 == INT and t2 == INT
            is_curve = t1 == INT and t2 == ENUM
            if (surface and is_surf) or (not surface and is_curve):
                c = Cursor(vals, i)
                try:
                    return read_bs3_surface(c) if surface else read_bs3_curve(c)
                except (AcisError, IndexError):
                    return None
        i += 1
    return None
