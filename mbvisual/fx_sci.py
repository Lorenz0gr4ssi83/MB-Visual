"""Dati scientifici e tabellari: HDF5 (.h5/.hdf5/.he5, anche NetCDF-4), NetCDF 3 classico (.nc), Parquet, Feather/Arrow.

Struttura (gruppi, dataset, variabili, attributi, schema), anteprima dei dati a pagine, campione per i grafici,
esportazione in CSV/Excel. Librerie: h5py (BSD-3), numpy (BSD-3), pyarrow (Apache-2.0); NetCDF 3 letto qui
(formato pubblico Unidata) senza netCDF4/scipy.
"""
from __future__ import annotations

import datetime as dt
import decimal
import json
import math
import mmap
import os
import struct

import numpy as np
from .i18n import t as tr

MAX_NODES = 5000
MAX_COLS = 300


# ---------------------------------------------------------------- tipo di file
def kind(path: str) -> str:
    with open(path, "rb") as f:
        h = f.read(8)
        if h[:4] == b"PAR1":
            return "parquet"
        if h[:6] == b"ARROW1":
            return "arrow"
        if h[:4] == b"FEA1":
            return "feather1"
        if h[:3] == b"CDF" and h[3] in (1, 2, 5):
            return "netcdf3"
        # firma HDF5 a 0, 512, 1024, 2048... (blocco utente)
        off = 0
        size = os.path.getsize(path)
        while off < size and off <= 1 << 20:
            f.seek(off)
            if f.read(8) == b"\x89HDF\r\n\x1a\n":
                return "hdf5"
            off = 512 if off == 0 else off * 2
    return "arrow_stream"


# ---------------------------------------------------------------- valori -> JSON
def _py(v):
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray, np.bytes_)):
        try:
            return bytes(v).decode("utf-8").rstrip("\x00")
        except UnicodeDecodeError:
            return bytes(v).hex()
    if isinstance(v, np.generic):
        v = v.item()
    if isinstance(v, float):
        return None if math.isnan(v) else (str(v) if math.isinf(v) else v)
    if isinstance(v, (int, bool, str)):
        return v
    if isinstance(v, (dt.datetime, dt.date, dt.time, dt.timedelta, decimal.Decimal)):
        return str(v)
    if isinstance(v, np.ndarray):
        return _short(json.dumps(_py(v.tolist()), ensure_ascii=False))
    if isinstance(v, (list, tuple)):
        return [_py(x) for x in v] if len(v) <= 50 else _short(str(list(v[:50])) + "...")
    if isinstance(v, dict):
        return _short(json.dumps({str(k): _py(x) for k, x in v.items()}, ensure_ascii=False, default=str))
    return _short(str(v))


def _short(s: str, n=400):
    return s if len(s) <= n else s[:n] + "..."


def _attr(v):
    v = _py(v)
    if isinstance(v, list):
        v = ", ".join(str(x) for x in v)
    return v


# ---------------------------------------------------------------- HDF5
def _h5():
    import h5py
    return h5py


def _h5_dtype(d) -> str:
    if d.names:
        return "composto {" + ", ".join(f"{n}: {d.fields[n][0]}" for n in d.names) + "}"
    if d.kind in "SO":
        return "testo"
    return str(d)


def _h5_open(path):
    h5py = _h5()
    return h5py.File(path, "r")


def _h5_tree(path):
    h5py = _h5()
    nodes = []
    with _h5_open(path) as f:
        nodes.append({"nome": "/", "tipo": "gruppo", "attributi": [{"k": k, "v": _attr(v)} for k, v in list(f.attrs.items())[:500]]})

        def visit(name, obj):
            if len(nodes) >= MAX_NODES:
                return True
            n = {"nome": "/" + name, "attributi": []}
            try:
                n["attributi"] = [{"k": k, "v": _attr(v)} for k, v in list(obj.attrs.items())[:500]]
            except Exception as e:  # noqa: BLE001
                n["attributi"] = [{"k": "(attributi)", "v": tr("srv_fx_sci.non_leggibili_0", e)}]
            if isinstance(obj, h5py.Dataset):
                n.update(tipo="dataset", forma=list(obj.shape) if obj.shape is not None else [], dtype=_h5_dtype(obj.dtype),
                         compressione=obj.compression or "", blocchi=list(obj.chunks) if obj.chunks else None,
                         numerico=obj.dtype.kind in "iufb" and not obj.dtype.names, campi=list(obj.dtype.names or []))
                if obj.dtype.kind in "iuf" and obj.size and obj.size <= 2_000_000 and not obj.dtype.names:
                    try:
                        a = obj[()]
                        n["min"], n["max"] = _py(np.nanmin(a)), _py(np.nanmax(a))
                    except Exception:
                        pass
            elif isinstance(obj, h5py.Group):
                n["tipo"] = "gruppo"
            else:
                n["tipo"] = "altro"
            nodes.append(n)
            return None
        f.visititems(visit)
    return nodes


def _h5_array(path, name, sel):
    with _h5_open(path) as f:
        d = f[name]
        return d[sel] if sel is not None else d[()], d.dtype


# ---------------------------------------------------------------- NetCDF 3
NC_TYPES = {1: ("i1", 1, "byte"), 2: ("S1", 1, "char"), 3: (">i2", 2, "short"), 4: (">i4", 4, "int"), 5: (">f4", 4, "float"),
            6: (">f8", 8, "double"), 7: ("u1", 1, "ubyte"), 8: (">u2", 2, "ushort"), 9: (">u4", 4, "uint"), 10: (">i8", 8, "int64"), 11: (">u8", 8, "uint64")}


class NC3:
    def __init__(self, path):
        self.f = open(path, "rb")
        self.m = mmap.mmap(self.f.fileno(), 0, access=mmap.ACCESS_READ)
        b = self.m
        if b[:3] != b"CDF":
            raise ValueError(tr("srv_fx_sci.non_file_netcdf_classico"))
        self.ver = b[3]
        self.p = 4
        big = self.ver == 5
        self._n = (lambda: self._u(">q")) if big else (lambda: self._u(">i"))
        self.numrecs = self._n()
        self.dims = []
        tag, cnt = self._u(">i"), self._n()
        for _ in range(cnt if tag == 10 else 0):
            nm = self._name()
            self.dims.append((nm, self._n()))
        self.attrs = self._atts()
        self.vars = []
        tag, cnt = self._u(">i"), self._n()
        for _ in range(cnt if tag == 11 else 0):
            nm = self._name()
            nd = self._n()
            ids = [self._n() for _ in range(nd)]
            at = self._atts()
            t = self._u(">i")
            vsize = self._u(">q") if big else self._u(">i")
            begin = self._u(">i") if self.ver == 1 else self._u(">q")
            shape = [self.dims[i][1] for i in ids]
            rec = bool(ids) and self.dims[ids[0]][1] == 0
            if rec:
                shape[0] = self.numrecs
            self.vars.append({"nome": nm, "dims": [self.dims[i][0] for i in ids], "tipo": t, "vsize": vsize, "inizio": begin,
                              "forma": shape, "record": rec, "attributi": at})
        recs = [v for v in self.vars if v["record"]]
        self.recsize = sum(v["vsize"] for v in recs) if len(recs) != 1 else int(np.prod(recs[0]["forma"][1:] or [1])) * NC_TYPES[recs[0]["tipo"]][1]

    def _u(self, fmt):
        n = struct.calcsize(fmt)
        v = struct.unpack_from(fmt, self.m, self.p)[0]
        self.p += n
        return v

    def _name(self):
        n = self._n()
        s = self.m[self.p:self.p + n].decode("utf-8", "replace")
        self.p += n + (-n % 4)
        return s

    def _atts(self):
        tag, cnt = self._u(">i"), self._n()
        out = []
        for _ in range(cnt if tag == 12 else 0):
            nm = self._name()
            t = self._u(">i")
            n = self._n()
            dtp, size, _lbl = NC_TYPES.get(t, ("u1", 1, "?"))
            raw = self.m[self.p:self.p + n * size]
            self.p += n * size + (-(n * size) % 4)
            if t == 2:
                v = raw.decode("utf-8", "replace").rstrip("\x00")
            else:
                a = np.frombuffer(raw, dtype=dtp)
                v = _py(a[0]) if n == 1 else [_py(x) for x in a[:100]]
            out.append({"k": nm, "v": _attr(v)})
        return out

    def array(self, var, sel=None):
        dtp, size, _ = NC_TYPES[var["tipo"]]
        shape = var["forma"]
        if not var["record"]:
            n = int(np.prod(shape or [1]))
            a = np.frombuffer(self.m, dtype=dtp, count=n, offset=var["inizio"]).reshape(shape or ())
        else:
            per = int(np.prod(shape[1:] or [1]))
            rows = range(self.numrecs)
            if sel is not None and isinstance(sel, tuple) and sel and isinstance(sel[0], slice):
                rows = range(*sel[0].indices(self.numrecs))
                sel = (slice(None),) + tuple(sel[1:])
            a = np.stack([np.frombuffer(self.m, dtype=dtp, count=per, offset=var["inizio"] + r * self.recsize).reshape(shape[1:]) for r in rows]) if len(rows) else np.zeros([0] + shape[1:], dtp)
        if var["tipo"] == 2 and a.ndim >= 1:  # testo: l'ultima dimensione sono i caratteri
            a = np.array([b"".join(x).decode("utf-8", "replace").rstrip("\x00") for x in a.reshape(-1, a.shape[-1])]).reshape(a.shape[:-1]) if a.ndim > 1 else np.array(b"".join(a).decode("utf-8", "replace").rstrip("\x00"))
        a = a[sel] if sel is not None else a
        return np.array(a)  # copia: i dati non devono restare legati al file mappato in memoria

    def close(self):
        self.m.close()
        self.f.close()


def _nc3_tree(path):
    nc = NC3(path)
    try:
        nodes = [{"nome": "/", "tipo": "gruppo", "attributi": nc.attrs + [{"k": tr("srv_fx_sci.formato"), "v": {1: tr("srv_fx_sci.netcdf_3_classico"), 2: tr("srv_fx_sci.netcdf_3_offset_64_bit"), 5: "NetCDF CDF-5"}[nc.ver]},
                                                                      {"k": tr("srv_fx_sci.dimensioni"), "v": ", ".join(f"{n} = {'illimitata (' + str(nc.numrecs) + ')' if s == 0 else s}" for n, s in nc.dims)}]}]
        for v in nc.vars:
            nodes.append({"nome": "/" + v["nome"], "tipo": "variabile", "forma": v["forma"], "dimensioni": v["dims"], "dtype": NC_TYPES[v["tipo"]][2],
                          "numerico": v["tipo"] not in (2,), "attributi": v["attributi"], "campi": []})
        return nodes
    finally:
        nc.close()


# ---------------------------------------------------------------- Parquet / Arrow
def _arrow_table(path, k):
    import pyarrow as pa
    import pyarrow.feather as feather
    if k == "feather1":
        return feather.read_table(path)
    src = pa.memory_map(path, "r")
    if k == "arrow":
        return pa.ipc.open_file(src).read_all()
    return pa.ipc.open_stream(src).read_all()


def _schema_rows(schema):
    return [{"k": f.name, "v": str(f.type) + ("" if f.nullable else tr("srv_fx_sci.non_nullo"))} for f in schema]


def _table_tree(path, k):
    if k == "parquet":
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(path)
        md = pf.metadata
        meta = [{"k": tr("srv_fx_sci.righe"), "v": md.num_rows}, {"k": tr("srv_fx_sci.colonne"), "v": md.num_columns}, {"k": tr("srv_fx_sci.gruppi_righe"), "v": md.num_row_groups},
                {"k": tr("srv_fx_sci.creato"), "v": md.created_by or ""}, {"k": tr("srv_fx_sci.versione_formato"), "v": md.format_version}]
        if md.num_row_groups:
            rg = md.row_group(0)
            comp = {rg.column(i).compression for i in range(rg.num_columns)}
            meta.append({"k": tr("srv_fx_sci.compressione"), "v": ", ".join(sorted(comp))})
        for key, val in (pf.schema_arrow.metadata or {}).items():
            meta.append({"k": tr("srv_fx_sci.metadati") + key.decode("utf-8", "replace"), "v": _short(val.decode("utf-8", "replace"), 2000)})
        schema = pf.schema_arrow
        rows = md.num_rows
    else:
        t = _arrow_table(path, k)
        schema, rows = t.schema, t.num_rows
        meta = [{"k": tr("srv_fx_sci.righe"), "v": rows}, {"k": tr("srv_fx_sci.colonne"), "v": t.num_columns},
                {"k": tr("srv_fx_sci.formato_2"), "v": {"arrow": tr("srv_fx_sci.arrow_ipc_file_feather_2"), "feather1": "Feather 1", "arrow_stream": tr("srv_fx_sci.arrow_ipc_flusso")}[k]}]
        for key, val in (schema.metadata or {}).items():
            meta.append({"k": tr("srv_fx_sci.metadati") + key.decode("utf-8", "replace"), "v": _short(val.decode("utf-8", "replace"), 2000)})
    return [{"nome": "/", "tipo": "tabella", "forma": [rows, len(schema)], "dtype": "tabella", "attributi": meta, "schema": _schema_rows(schema),
             "campi": schema.names, "numerico": False}]


def _table_slice(path, k, start, n):
    if k == "parquet":
        import pyarrow as pa
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(path)
        md = pf.metadata
        parts, pos = [], 0
        for g in range(md.num_row_groups):
            cnt = md.row_group(g).num_rows
            if pos + cnt > start and pos < start + n:
                parts.append((g, pos))
            pos += cnt
        if not parts:
            return pf.schema_arrow.empty_table(), md.num_rows
        t = pa.concat_tables([pf.read_row_group(g) for g, _ in parts])
        return t.slice(start - parts[0][1], n), md.num_rows
    t = _arrow_table(path, k)
    return t.slice(start, n), t.num_rows


# ---------------------------------------------------------------- API
def open_file(path: str) -> dict:
    k = kind(path)
    if k == "hdf5":
        nodes, fmt = _h5_tree(path), "HDF5"
        if any(a["k"] in ("_NCProperties",) for a in nodes[0]["attributi"]) or any(a["k"] == "DIMENSION_LIST" for n in nodes for a in n["attributi"]):
            fmt = "NetCDF-4 (HDF5)"
    elif k == "netcdf3":
        nodes, fmt = _nc3_tree(path), "NetCDF 3"
    else:
        try:
            nodes = _table_tree(path, k)
        except Exception as e:  # noqa: BLE001
            raise ValueError(tr("srv_fx_sci.formato_non_riconosciuto_ne_hdf5", e)) from e
        fmt = {"parquet": "Parquet", "arrow": tr("srv_fx_sci.arrow_feather_2"), "feather1": "Feather 1", "arrow_stream": tr("srv_fx_sci.arrow_flusso_ipc")}[k]
    return {"ok": True, "formato": fmt, "tipo": k, "nodi": nodes, "troncato": len(nodes) >= MAX_NODES}


def _matrix(a: np.ndarray, dtype=None):
    """Array (gia' ridotto a <= 2 dimensioni) -> colonne e righe."""
    if dtype is not None and dtype.names:
        cols = list(dtype.names)
        rows = [[_py(r[c]) for c in cols] for r in np.atleast_1d(a)]
        return cols, rows
    if a.ndim == 0:
        return ["valore"], [[_py(a)]]
    if a.ndim == 1:
        return ["valore"], [[_py(x)] for x in a]
    cols = [str(i) for i in range(min(a.shape[1], MAX_COLS))]
    return cols, [[_py(x) for x in r[:MAX_COLS]] for r in a]


def _selector(shape, fetta, start, n):
    """Indici: per >2 dimensioni si sceglie una "fetta" sulle prime; le righe sono la penultima (o unica) dimensione."""
    nd = len(shape)
    if nd <= 2:
        return (slice(start, start + n),) if nd else None, nd
    fetta = list(fetta or [])[: nd - 2]
    fetta += [0] * (nd - 2 - len(fetta))
    fetta = [max(0, min(int(x), shape[i] - 1)) for i, x in enumerate(fetta)]
    return tuple(fetta) + (slice(start, start + n),), nd


def _chart(a: np.ndarray, base: int = 1):
    """Campione per i grafici: serie (1D, o poche colonne) oppure mappa (2D), al massimo 2000 punti / 300x300."""
    try:
        if a.dtype.kind not in "iufb" or a.size == 0:
            return None
        a = a.astype("f8")
        if a.ndim == 1:
            step = max(1, a.size // 2000)
            return {"tipo": "serie", "x0": 0, "passo": step * base, "serie": [np.where(np.isfinite(a[::step]), a[::step], np.nan).tolist()]}
        if a.ndim == 2 and a.shape[1] <= 8:
            step = max(1, a.shape[0] // 2000)
            return {"tipo": "serie", "x0": 0, "passo": step * base, "serie": [a[::step, j].tolist() for j in range(a.shape[1])]}
        if a.ndim == 2:
            sy, sx = max(1, math.ceil(a.shape[0] / 300)), max(1, math.ceil(a.shape[1] / 300))
            m = a[::sy, ::sx]
            fin = m[np.isfinite(m)]
            return {"tipo": "mappa", "righe": m.shape[0], "colonne": m.shape[1], "min": float(fin.min()) if fin.size else 0, "max": float(fin.max()) if fin.size else 1,
                    "valori": np.where(np.isfinite(m), m, np.nan).ravel().tolist()}
    except Exception:
        return None
    return None


def _clean_chart(c):
    if not c:
        return c
    fix = lambda v: None if v is None or (isinstance(v, float) and not math.isfinite(v)) else v  # noqa: E731
    if c["tipo"] == "serie":
        c["serie"] = [[fix(v) for v in s] for s in c["serie"]]
    else:
        c["valori"] = [fix(v) for v in c["valori"]]
    return c


def data(path: str, name: str, start: int = 0, n: int = 200, fetta=None) -> dict:
    k = kind(path)
    n = max(1, min(int(n), 5000))
    if k in ("hdf5", "netcdf3"):
        sample, base = None, 1
        if k == "hdf5":
            with _h5_open(path) as f:
                d = f[name]
                shape, dtype = list(d.shape or []), d.dtype
                sel, nd = _selector(shape, fetta, start, n)
                a = d[sel] if sel is not None else d[()]
                if nd >= 1 and dtype.kind in "iufb" and not dtype.names and d.size:
                    sample, base = _downsampled(d, shape, fetta)
        else:
            nc = NC3(path)
            try:
                v = next(x for x in nc.vars if "/" + x["nome"] == name)
                shape, dtype = v["forma"], None
                sel, nd = _selector(shape, fetta, start, n)
                a = nc.array(v, sel)
                if v["tipo"] != 2 and nd >= 1 and int(np.prod(shape)):
                    sample = nc.array(v, _selector(shape, fetta, 0, shape[-2] if nd >= 2 else shape[0])[0])
            finally:
                nc.close()
        total = shape[-2] if len(shape) >= 2 else (shape[0] if shape else 1)
        cols, rows = _matrix(np.asarray(a), dtype)
        return {"ok": True, "colonne": cols, "righe": rows, "totale": int(total), "da": start, "forma": shape,
                "colonne_troncate": len(shape) >= 2 and shape[-1] > MAX_COLS,
                "grafico": _clean_chart(_chart(np.asarray(sample), base)) if sample is not None else None}
    t, total = _table_slice(path, k, start, n)
    cols = t.column_names
    py = t.to_pylist()
    rows = [[_py(r.get(c)) for c in cols] for r in py]
    return {"ok": True, "colonne": cols, "righe": rows, "totale": int(total), "da": start, "forma": [int(total), len(cols)], "grafico": None}


def _downsampled(d, shape, fetta):
    """Dataset HDF5 numerico ridotto (con passo) per il grafico, senza leggerlo tutto se e' grande."""
    nd = len(shape)
    if nd == 1:
        step = max(1, shape[0] // 2000)
        return d[::step], step
    lead, _ = _selector(shape, fetta, 0, 1)
    lead = lead[:-1]
    if shape[-1] <= 8:  # poche colonne: serie
        sy, sx = max(1, shape[-2] // 2000), 1
    else:  # mappa
        sy, sx = max(1, math.ceil(shape[-2] / 300)), max(1, math.ceil(shape[-1] / 300))
    return d[lead + (slice(None, None, sy), slice(None, None, sx))], sy


def _iter_rows(path, name, fetta, k):
    """Righe dell'intero dataset/tabella, a blocchi (per l'esportazione)."""
    if k in ("hdf5", "netcdf3"):
        first = data(path, name, 0, 1, fetta)
        total = first["totale"]
        yield first["colonne"]
        for s in range(0, max(total, 1), 5000):
            for r in data(path, name, s, 5000, fetta)["righe"]:
                yield r
        return
    if k == "parquet":
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(path)
        yield pf.schema_arrow.names
        for b in pf.iter_batches(batch_size=5000):
            for r in b.to_pylist():
                yield [_py(v) for v in r.values()]
        return
    t = _arrow_table(path, k)
    yield t.column_names
    for b in t.to_batches(max_chunksize=5000):
        for r in b.to_pylist():
            yield [_py(v) for v in r.values()]


def export(path: str, name: str, out: str, fetta=None) -> dict:
    k = kind(path)
    ext = out.rsplit(".", 1)[-1].lower()
    it = _iter_rows(path, name or "/", fetta, k)
    cols = next(it)
    n = 0
    if ext == "csv":
        import csv
        with open(out, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(cols)
            for r in it:
                w.writerow(["" if v is None else v for v in r])
                n += 1
    elif ext == "xlsx":
        from openpyxl import Workbook
        wb = Workbook(write_only=True)
        ws = wb.create_sheet((name.strip("/").replace("/", "_") or tr("srv_fx_sci.dati"))[:31])
        ws.append(cols)
        for r in it:
            if n >= 1_048_575:
                break
            ws.append([v if not isinstance(v, list) else str(v) for v in r])
            n += 1
        wb.save(out)
    else:
        raise ValueError(tr("srv_fx_sci.formato_esportazione_non_previsto_0", ext))
    return {"ok": True, "path": out, "righe": n}
