"""Lettore dei file Parasolid XT (testo .x_t / binario neutro .x_b, anche partizioni .p_t/.p_b).

Scritto da zero sulla specifica pubblica "Parasolid XT Format Reference" (UGS, ottobre 2006): nessun codice di terzi.
Il file e' una sequenza di nodi tipizzati (indice, campi) descritti da uno schema; dalla versione 14 ogni file porta
le differenze del proprio schema rispetto allo schema di base SCH_13006, che qui e' scritto a mano dalla specifica.

Uso: parse(bytes) -> XTFile con .nodes {indice: Node}, .root (nodo radice), .kind ('part' | 'partition' | 'deltas').
"""
import math
import struct

from .i18n import t as tr

NULL_INT = -32764
NULL_REAL = -3.14158e13


class XTError(Exception):
    pass


class Node:
    __slots__ = ("type", "index", "f")

    def __init__(self, type_, index, fields):
        self.type = type_
        self.index = index
        self.f = fields

    def __getitem__(self, k):
        return self.f.get(k)

    def get(self, k, default=None):
        v = self.f.get(k)
        return default if v is None else v

    def __repr__(self):
        return f"<{TYPE_NAMES.get(self.type, self.type)} #{self.index}>"


# ---------------------------------------------------------------- schema di base (SCH_13006, dalla specifica)
# campo = (nome, tipo, n_elementi): n=0 scalare, n=1 lunghezza variabile (ultimo campo), n>1 vettore fisso
def _f(spec):
    out = []
    for item in spec.split():
        name, t = item.split(":")
        n = 0
        if "[" in t:
            t, k = t[:-1].split("[")
            n = 1 if k == "" else int(k)
        out.append((name, t, n))
    return out


_CURVE = "node_id:d attributes_groups:p owner:p next:p previous:p geometric_owner:p sense:c "
_SURF = _CURVE
BASE = {
    10: ("ASSEMBLY", "highest_node_id:d attributes_groups:p attribute_chains:p list:p surface:p curve:p point:p key:p res_size:f res_linear:f ref_instance:p next:p previous:p state:u owner:p type:u sub_instance:p"),
    11: ("INSTANCE", "node_id:d attributes_groups:p type:u part:p transform:p assembly:p next_in_part:p prev_in_part:p next_of_part:p prev_of_part:p"),
    12: ("BODY", "highest_node_id:d attributes_groups:p attribute_chains:p surface:p curve:p point:p key:p res_size:f res_linear:f ref_instance:p next:p previous:p state:u owner:p body_type:u nom_geom_state:u shell:p boundary_surface:p boundary_curve:p boundary_point:p region:p edge:p vertex:p"),
    13: ("SHELL", "node_id:d attributes_groups:p body:p next:p face:p edge:p vertex:p region:p front_face:p"),
    14: ("FACE", "node_id:d attributes_groups:p tolerance:f next:p previous:p loop:p shell:p surface:p sense:c next_on_surface:p previous_on_surface:p next_front:p previous_front:p front_shell:p"),
    15: ("LOOP", "node_id:d attributes_groups:p fin:p face:p next:p"),
    16: ("EDGE", "node_id:d attributes_groups:p tolerance:f fin:p previous:p next:p curve:p next_on_curve:p previous_on_curve:p owner:p"),
    17: ("FIN", "attributes_groups:p loop:p forward:p backward:p vertex:p other:p edge:p curve:p next_at_vx:p sense:c"),
    18: ("VERTEX", "node_id:d attributes_groups:p fin:p previous:p next:p point:p tolerance:f owner:p"),
    19: ("REGION", "node_id:d attributes_groups:p body:p next:p previous:p shell:p type:c"),
    29: ("POINT", "node_id:d attributes_groups:p owner:p next:p previous:p pvec:v"),
    30: ("LINE", _CURVE + "pvec:v direction:v"),
    31: ("CIRCLE", _CURVE + "centre:v normal:v x_axis:v radius:f"),
    32: ("ELLIPSE", _CURVE + "centre:v normal:v x_axis:v major_radius:f minor_radius:f"),
    38: ("INTERSECTION", _CURVE + "surface:p[2] chart:p start:p end:p"),
    40: ("CHART", "base_parameter:f base_scale:f chart_count:d chordal_error:f angular_error:f parameter_error:f[2] hvec:h[]"),
    41: ("LIMIT", "type:c hvec:h[]"),
    45: ("BSPLINE_VERTICES", "vertices:f[]"),
    50: ("PLANE", _SURF + "pvec:v normal:v x_axis:v"),
    51: ("CYLINDER", _SURF + "pvec:v axis:v radius:f x_axis:v"),
    52: ("CONE", _SURF + "pvec:v axis:v radius:f sin_half_angle:f cos_half_angle:f x_axis:v"),
    53: ("SPHERE", _SURF + "centre:v radius:f axis:v x_axis:v"),
    54: ("TORUS", _SURF + "centre:v axis:v major_radius:f minor_radius:f x_axis:v"),
    56: ("BLENDED_EDGE", _SURF + "blend_type:c surface:p[2] spine:p range:f[2] thumb_weight:f[2] boundary:p[2] start:p end:p"),
    59: ("BLEND_BOUND", _SURF + "boundary:n blend:p"),
    60: ("OFFSET_SURF", _SURF + "check:c true_offset:l surface:p offset:f scale:f"),
    67: ("SWEPT_SURF", _SURF + "section:p sweep:v scale:f"),
    68: ("SPUN_SURF", _SURF + "profile:p base:v axis:v start:v end:v start_param:f end_param:f x_axis:v scale:f"),
    70: ("LIST", "node_id:d owner:p next:p previous:p list_type:d list_length:d block_length:d size_of_entry:d list_block:p finger_block:p finger_index:d notransmit:l"),
    74: ("POINTER_LIS_BLOCK", "n_entries:d next_block:p entries:p[]"),
    79: ("ATT_DEF_ID", "string:c[]"),
    80: ("ATTRIB_DEF", "next:p identifier:p type_id:d actions:u[8] field_names:p legal_owners:l[14] fields:u[]"),
    81: ("ATTRIBUTE", "node_id:d definition:p owner:p next:p previous:p next_of_type:p previous_of_type:p fields:p[]"),
    82: ("INT_VALUES", "values:d[]"),
    83: ("REAL_VALUES", "values:f[]"),
    84: ("CHAR_VALUES", "values:c[]"),
    85: ("POINT_VALUES", "values:v[]"),
    86: ("VECTOR_VALUES", "values:v[]"),
    87: ("AXIS_VALUES", "values:v[]"),
    88: ("TAG_VALUES", "values:d[]"),
    89: ("DIRECTION_VALUES", "values:v[]"),
    90: ("GROUP", "node_id:d attributes_groups:p owner:p next:p previous:p type:u first_member:p"),
    91: ("MEMBER_OF_GROUP", "dummy_node_id:d owning_group:p owner:p next:p previous:p next_member:p previous_member:p"),
    98: ("UNICODE_VALUES", "values:w[]"),
    99: ("FIELD_NAMES", "names:p[]"),
    100: ("TRANSFORM", "node_id:d owner:p next:p previous:p rotation_matrix:f[9] translation_vector:v scale:f flag:d perspective_vector:v"),
    101: ("WORLD", "assembly:p attribute:p body:p transform:p surface:p curve:p point:p alive:l attrib_def:p highest_id:d current_id:d"),
    102: ("KEY", "string:c[]"),
    120: ("PE_SURF", _SURF + "type:c data:p tf:p internal_geom:p[]"),
    121: ("INT_PE_DATA", "geom_type:d real_array:p int_array:p"),
    122: ("EXT_PE_DATA", "key:p real_array:p int_array:p"),
    124: ("B_SURFACE", _SURF + "nurbs:p data:p"),
    125: ("SURFACE_DATA", "original_uint:i original_vint:i extended_uint:i extended_vint:i self_int:u original_u_start:c original_u_end:c original_v_start:c original_v_end:c extended_u_start:c extended_u_end:c extended_v_start:c extended_v_end:c analytic_form_type:c swept_form_type:c spun_form_type:c blend_form_type:c analytic_form:p swept_form:p spun_form:p blend_form:p"),
    126: ("NURBS_SURF", "u_periodic:l v_periodic:l u_degree:n v_degree:n n_u_vertices:d n_v_vertices:d u_knot_type:u v_knot_type:u n_u_knots:d n_v_knots:d rational:l u_closed:l v_closed:l surface_form:u vertex_dim:n bspline_vertices:p u_knot_mult:p v_knot_mult:p u_knots:p v_knots:p"),
    127: ("KNOT_MULT", "mult:n[]"),
    128: ("KNOT_SET", "knots:f[]"),
    130: ("PE_CURVE", _CURVE + "type:c data:p tf:p internal_geom:p[]"),
    133: ("TRIMMED_CURVE", _CURVE + "basis_curve:p point_1:v point_2:v parm_1:f parm_2:f"),
    134: ("B_CURVE", _CURVE + "nurbs:p data:p"),
    135: ("CURVE_DATA", "self_int:u analytic_form:p"),
    136: ("NURBS_CURVE", "degree:n n_vertices:d vertex_dim:n n_knots:d knot_type:u periodic:l closed:l rational:l curve_form:u bspline_vertices:p knot_mult:p knots:p"),
    137: ("SP_CURVE", _CURVE + "surface:p b_curve:p original:p tolerance_to_original:f"),
    141: ("GEOMETRIC_OWNER", "owner:p next:p previous:p shared_geometry:p"),
    163: ("HELIX_CU_FORM", "axis_pt:v axis_dir:v point:v hand:c turns:i pitch:f tol:f"),
    184: ("HELIX_SU_FORM", "axis_pt:v axis_dir:v hand:c turns:i pitch:f gap:f tol:f"),
}
BASE = {k: (n, _f(s)) for k, (n, s) in BASE.items()}
TYPE_NAMES = {k: v[0] for k, v in BASE.items()}


# ---------------------------------------------------------------- lettori di basso livello
class _Text:
    """Flusso di testo: i ritorni a capo non contano, ogni numero e' seguito da uno spazio, '?' = valore nullo."""

    def __init__(self, s: str, pos: int):
        self.s = s
        self.p = pos

    def _tok(self):
        s, p = self.s, self.p
        if s[p] == "?":
            self.p = p + 1
            return None
        q = s.find(" ", p)
        if q < 0:
            q = len(s)
        self.p = q + 1
        return s[p:q]

    def int(self):
        t = self._tok()
        if t is None:
            return None
        try:
            return int(t)
        except ValueError:
            raise XTError(tr("srv_solidcad.xt_atteso_intero", t[:20], self.p))

    def real(self):
        t = self._tok()
        if t is None:
            return None
        try:
            return float(t)
        except ValueError:
            raise XTError(tr("srv_solidcad.xt_atteso_reale", t[:20], self.p))

    ptr = byte = short = posint = int

    def char(self):
        c = self.s[self.p]
        self.p += 1
        return c

    def logical(self):
        c = self.s[self.p]
        self.p += 1
        if c not in "TF":
            raise XTError(tr("srv_solidcad.xt_atteso_logico", c, self.p))
        return c == "T"

    def chars(self, n):
        # sequenze di escape (V12.1+): \0 \n \r \\ ; \9 = nove spazi (V14+)
        out = []
        s, p = self.s, self.p
        while len(out) < n and p < len(s):
            c = s[p]
            p += 1
            if c == "\\" and p < len(s):
                e = s[p]
                p += 1
                if e == "9":
                    out.extend(" " * 9)
                    continue
                c = {"0": "\0", "n": "\n", "r": "\r", "\\": "\\"}.get(e, e)
            out.append(c)
        self.p = p
        return "".join(out[:n])

    def shortstr(self):
        n = self.int()
        return self.chars(n or 0)

    def vector(self):
        if self.s[self.p] == "?":
            self.p += 1
            return None
        return (self.real(), self.real(), self.real())

    def at_end(self):
        return self.p >= len(self.s) - 1


class _Bin:
    """Binario neutro (big-endian, IEEE)."""

    def __init__(self, b: bytes, pos: int):
        self.b = b
        self.p = pos

    def byte(self):
        v = self.b[self.p]
        self.p += 1
        return v

    def short(self):
        v = struct.unpack_from(">h", self.b, self.p)[0]
        self.p += 2
        return v

    def int(self):
        v = struct.unpack_from(">i", self.b, self.p)[0]
        self.p += 4
        return None if v == NULL_INT else v

    def ptr(self):
        r = struct.unpack_from(">h", self.b, self.p)[0]
        self.p += 2
        q = 0
        if r < 0:
            q = struct.unpack_from(">h", self.b, self.p)[0]
            self.p += 2
            r = -r
        return q * 32767 + r - 1

    posint = ptr

    def real(self):
        v = struct.unpack_from(">d", self.b, self.p)[0]
        self.p += 8
        return None if abs(v - NULL_REAL) < 1e3 else v

    def char(self):
        c = chr(self.b[self.p])
        self.p += 1
        return c

    def logical(self):
        v = self.b[self.p]
        self.p += 1
        return bool(v)

    def chars(self, n):
        s = self.b[self.p:self.p + n].decode("latin-1")
        self.p += n
        return s

    def shortstr(self):
        n = self.byte()
        return self.chars(n)

    def vector(self):
        x, y, z = struct.unpack_from(">ddd", self.b, self.p)
        self.p += 24
        if abs(x - NULL_REAL) < 1e3:
            return None
        return (x, y, z)

    def at_end(self):
        return self.p >= len(self.b) - 1


# ---------------------------------------------------------------- lettura di un campo
def _read_value(r, t):
    if t == "d" or t == "t":
        return r.int()
    if t == "p":
        return r.ptr()
    if t == "f":
        return r.real()
    if t == "v" or t == "h":
        return r.vector()
    if t == "c":
        return r.char()
    if t == "l":
        return r.logical()
    if t == "u":
        return r.byte()
    if t in ("n", "w"):
        return r.short()
    if t == "i":
        a = r.real()
        b = r.real()
        return (a, b)
    if t == "b":
        return tuple(r.real() for _ in range(6))
    raise XTError(tr("srv_solidcad.xt_campo_sconosciuto", t))


class XTFile:
    def __init__(self):
        self.nodes = {}
        self.root = None
        self.kind = "part"
        self.version = ""
        self.schema = ""
        self.header = {}
        self.unknown_types = set()

    def node(self, idx):
        return self.nodes.get(idx) if idx else None

    def chain(self, idx, field="next"):
        """Segue una catena di nodi (next) a partire da idx, con protezione dai cicli."""
        seen = set()
        out = []
        n = self.node(idx)
        while n is not None and n.index not in seen:
            seen.add(n.index)
            out.append(n)
            n = self.node(n.f.get(field))
        return out


def _parse_header(data: bytes):
    """Intestazione testuale (**PART1 ... **END_OF_HEADER) facoltativa. Ritorna (dizionario, posizione dei dati)."""
    head = {}
    if data[:2] != b"**":
        return head, 0
    end = data.find(b"**END_OF_HEADER")
    if end < 0:
        return head, 0
    nl = data.find(b"\n", end)
    txt = data[:end].decode("latin-1", "replace")
    flat = "".join(line for line in txt.splitlines() if not line.startswith("**ABCD") and not line.startswith("**PARASOLID"))
    for part in flat.replace("**PART1;", ";").replace("**PART2;", ";").replace("**PART3;", ";").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            head[k.strip()] = v.replace("^_", " ").replace("^;", ";").replace("^n", "\n").replace("^^", "^")
    return head, (nl + 1 if nl >= 0 else end + 15)


def parse(data: bytes) -> XTFile:
    xt = XTFile()
    xt.header, pos = _parse_header(data)
    if data[pos:pos + 4] == b"PS\x00\x00":
        r = _Bin(data, pos + 4)
        n = r.short()
        xt.version = r.chars(n)
        n = struct.unpack_from(">i", data, r.p)[0]
        r.p += 4
        xt.schema = r.chars(n)
        binary = True
    else:
        # testo: le righe si uniscono senza separatori (i ritorni a capo non sono significativi)
        txt = data[pos:].decode("latin-1").replace("\r", "").replace("\n", "")
        if not txt.startswith("T"):
            raise XTError(tr("srv_solidcad.xt_formato"))
        r = _Text(txt, 1)
        n = r.int()
        xt.version = r.chars(n)
        n = r.int()
        xt.schema = r.chars(n)
        binary = False
    if "partition" in xt.version:
        xt.kind = "partition"
    elif "deltas" in xt.version:
        xt.kind = "deltas"
    sch = xt.schema.split("_")
    embedded = len(sch) >= 4
    if embedded:
        r.short()  # numero massimo di tipi di nodo
    if binary:
        r.p += 4  # dimensione del campo utente (intero a 4 byte)
        usfld = struct.unpack_from(">i", data, r.p - 4)[0]
    else:
        usfld = r.int() or 0
    # schemi vecchi (verificati su file reali): fino alla V11 fin senza attributi e definizioni di attributo senza
    # nomi dei campi e con 13 proprietari; nella V9 anche il corpo senza nom_geom_state (verificato su file reali)
    schema = {k: (v[0], list(v[1])) for k, v in BASE.items()}
    try:
        ver = int(sch[1])
        if not embedded and ver < 1200000:
            schema[17] = ("FIN", [f for f in schema[17][1] if f[0] != "attributes_groups"])
            schema[80] = ("ATTRIB_DEF", [(n, t, 13 if n == "legal_owners" else k) for n, t, k in schema[80][1] if n != "field_names"])
        if not embedded and ver < 1000000:
            schema[12] = ("BODY", [f for f in schema[12][1] if f[0] != "nom_geom_state"])
    except (ValueError, IndexError):
        pass
    seen_types = set()
    nodes = xt.nodes
    while True:
        if r.at_end():
            break
        t = r.short() if binary else r.int()
        if t is None:
            raise XTError(tr("srv_solidcad.xt_tipo_nullo"))
        if t == 1:
            # terminatore: tipo 1 seguito dall'indice 0
            break
        if embedded and t not in seen_types:
            seen_types.add(t)
            schema[t] = _read_schema_edit(r, t, schema.get(t), binary)
        spec = schema.get(t)
        if spec is None:
            raise XTError(tr("srv_solidcad.xt_tipo_ignoto", t, xt.schema))
        name, fields = spec
        varlen = None
        if fields and fields[-1][2] == 1:
            varlen = (struct.unpack_from(">i", data, r.p)[0], setattr(r, "p", r.p + 4))[0] if binary else r.int()
        idx = r.ptr()
        vals = {}
        for fname, ft, ne in fields:
            if ne == 0:
                vals[fname] = _read_value(r, ft)
            elif ne == 1:
                if ft == "c":
                    vals[fname] = r.chars(varlen or 0)
                else:
                    vals[fname] = [_read_value(r, ft) for _ in range(varlen or 0)]
            else:
                if ft == "c":
                    vals[fname] = r.chars(ne)
                else:
                    vals[fname] = [_read_value(r, ft) for _ in range(ne)]
        # campi utente: in pratica presenti dopo ogni nodo (non solo quelli visibili al PK)
        for _ in range(usfld):
            r.int()
        nodes[idx] = Node(t, idx, vals)
        if xt.root is None:
            xt.root = nodes[idx]
    return xt


# tipi visibili all'interfaccia PK (hanno i campi utente quando USFLD_SIZE > 0)
_PK_VISIBLE = {10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 29, 30, 31, 32, 38, 50, 51, 52, 53, 54, 56, 60, 67, 68, 70, 80, 81,
               90, 100, 120, 124, 130, 133, 134, 137}


def _read_field_desc(r, binary):
    name = r.shortstr()
    ptr_class = r.short() if binary else r.int()
    n_elts = r.posint()
    ftype = "p"
    if not ptr_class:
        ftype = r.shortstr()
    xmt = True
    if n_elts == 1:
        xmt = r.logical()
    return (name, ftype, n_elts, xmt)


def _read_schema_edit(r, t, base, binary):
    """Schema incorporato: differenze rispetto allo schema di base per il primo nodo di ogni tipo."""
    nf = r.byte()
    if nf == 255:
        if base is None:
            raise XTError(tr("srv_solidcad.xt_schema_base", t))
        return base
    if base is None:
        # tipo nuovo: nome, descrizione e tutti i campi
        name = r.shortstr()
        r.shortstr()
        fields = []
        for _ in range(nf):
            fd = _read_field_desc(r, binary)
            fields.append(fd)
        return (name, [(n, ty, ne) for n, ty, ne, xmt in fields if xmt or ne == 1])
    name, bfields = base
    out = []
    bi = 0
    while True:
        op = r.char()
        if op == "C":
            out.append(bfields[bi])
            bi += 1
        elif op == "D":
            bi += 1
        elif op in ("I", "A"):
            n, ty, ne, xmt = _read_field_desc(r, binary)
            out.append((n, ty, ne))
        elif op == "Z":
            break
        else:
            raise XTError(tr("srv_solidcad.xt_schema_op", op, t))
    return (name, out)


# ---------------------------------------------------------------- utilita' per chi usa il modello
def attr_string(xt: XTFile, attrib: Node):
    """Testo dei campi di un attributo (CHAR_VALUES / UNICODE_VALUES)."""
    out = []
    for fi in attrib.get("fields", []) or []:
        n = xt.node(fi)
        if n is None:
            continue
        if n.type == 84:
            out.append(n.get("values", ""))
        elif n.type == 98:
            out.append("".join(chr(c & 0xFFFF) for c in n.get("values", []) if c))
    return "".join(out)


def attributes_of(xt: XTFile, node: Node):
    """Attributi collegati a un nodo: lista di (nome della definizione, nodo ATTRIBUTE)."""
    out = []
    seen = set()
    a = xt.node(node.f.get("attributes_groups"))
    while a is not None and a.index not in seen:
        seen.add(a.index)
        if a.type == 81:
            d = xt.node(a.get("definition"))
            ident = xt.node(d.get("identifier")) if d else None
            out.append((ident.get("string", "") if ident else "", a))
        a = xt.node(a.f.get("next"))
    return out


def real_values(xt: XTFile, attrib: Node):
    vals = []
    for fi in attrib.get("fields", []) or []:
        n = xt.node(fi)
        if n is not None and n.type == 83:
            vals.extend(v for v in n.get("values", []) if v is not None)
    return vals


def is_finite(v):
    return v is not None and not (isinstance(v, float) and (math.isnan(v) or math.isinf(v)))
