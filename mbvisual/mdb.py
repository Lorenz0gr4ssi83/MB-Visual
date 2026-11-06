"""Database Microsoft Access (.mdb Jet 3/4, .accdb ACE) senza Access: lettura con access_parser (Apache-2.0, Python puro) e copia
in un database SQLite in cache, che si apre con il visualizzatore SQLite dell'app (tabelle, ricerca, query). L'originale non si tocca:
le modifiche fatte nel visualizzatore restano nella copia. Tabelle di sistema (MSys*) escluse. Le query salvate, i moduli e i report
di Access non sono dati: non si copiano."""
import hashlib
import os
import sqlite3
from pathlib import Path

from .i18n import t as tr
from .paths import TEMP_DIR

CACHE = TEMP_DIR / "access"
VERSION = 1


def _key(path: str) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}|{VERSION}".encode()).hexdigest()[:16]


def _sql_type(values) -> str:
    kinds = {type(v) for v in values if v is not None}
    if kinds and kinds <= {int, bool}:
        return "INTEGER"
    if kinds and kinds <= {int, float, bool}:
        return "REAL"
    if kinds == {bytes}:
        return "BLOB"
    return "TEXT"


def _cell(v):
    if v is None or isinstance(v, (int, float, str, bytes)):
        return v
    return str(v)  # date, decimali, GUID...


def to_sqlite(path: str, update=lambda *a, **k: None) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / (_key(path) + ".sqlite")
    if out.exists():
        return {"ok": True, "path": str(out), "cache": True}
    from access_parser import AccessParser
    update(progress=0.05, message=tr("srv_mdb.lettura"))
    db = AccessParser(path)
    names = [n for n in db.catalog if not n.startswith(("MSys", "~"))]
    tmp = out.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    skipped = []
    for i, name in enumerate(names):
        update(progress=0.1 + 0.85 * i / max(1, len(names)), message=tr("srv_mdb.tabella", name))
        try:
            data = db.parse_table(name) or {}
        except Exception:  # noqa: BLE001 - una tabella illeggibile non ferma le altre
            skipped.append(name)
            continue
        cols = list(data.keys())
        if not cols:
            con.execute(f'CREATE TABLE "{name}" (_vuota INTEGER)')
            continue
        n = max(len(v) for v in data.values())
        defs = ", ".join(f'"{c}" {_sql_type(data[c][:500])}' for c in cols)
        con.execute(f'CREATE TABLE "{name}" ({defs})')
        rows = ([_cell(data[c][r]) if r < len(data[c]) else None for c in cols] for r in range(n))
        con.executemany(f'INSERT INTO "{name}" VALUES ({", ".join("?" * len(cols))})', rows)
    if skipped:
        con.execute("CREATE TABLE _mbdesk_tabelle_non_lette (nome TEXT)")
        con.executemany("INSERT INTO _mbdesk_tabelle_non_lette VALUES (?)", [(s,) for s in skipped])
    con.commit()
    con.close()
    os.replace(tmp, out)
    return {"ok": True, "path": str(out), "tabelle": len(names), "non_lette": skipped}
