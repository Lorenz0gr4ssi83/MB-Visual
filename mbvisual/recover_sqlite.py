"""Recupero dei database SQLite danneggiati (come il comando .recover della riga di comando di sqlite3).

Se sqlite3.exe e' disponibile (bin/sqlite o PATH) si usa il suo `.recover`; altrimenti si leggono le pagine a mano
seguendo il formato pubblico (https://sqlite.org/fileformat.html): B-tree delle tabelle a partire da sqlite_master,
celle con payload e pagine di overflow, e le pagine foglia non raggiunte da nessuna tabella finiscono in
"lost_and_found" (stesse colonne di .recover: rootpgno, pgno, nfield, id, c0, c1...).
"""
from __future__ import annotations

import shutil
import sqlite3
import struct
import subprocess
from pathlib import Path

from .paths import BIN_DIR, NO_WINDOW



def find_sqlite_cli() -> str | None:
    for p in (BIN_DIR / "sqlite" / "sqlite3.exe",):
        if p.is_file():
            return str(p)
    return shutil.which("sqlite3")


def _varint(b: bytes, i: int) -> tuple[int, int]:
    v = 0
    for k in range(9):
        if i >= len(b):
            raise ValueError("varint")
        c = b[i]
        i += 1
        if k == 8:
            return (v << 8) | c, i
        v = (v << 7) | (c & 0x7F)
        if c < 0x80:
            return v, i
    return v, i


def _signed(v: int, bits: int) -> int:
    return v - (1 << bits) if v >= 1 << (bits - 1) else v


class Reader:
    def __init__(self, data: bytes):
        self.d = data
        ps = struct.unpack(">H", data[16:18])[0] if len(data) >= 100 else 4096
        self.ps = 65536 if ps == 1 else (ps if ps >= 512 and ps & (ps - 1) == 0 else 4096)
        reserved = data[20] if len(data) > 20 else 0
        self.usable = self.ps - reserved
        self.npages = len(data) // self.ps + (1 if len(data) % self.ps else 0)
        self.enc = {1: "utf-8", 2: "utf-16-le", 3: "utf-16-be"}.get(struct.unpack(">I", data[56:60])[0] if len(data) >= 60 else 1, "utf-8")
        self.visited: set[int] = set()
        self.errors = 0

    def page(self, n: int) -> bytes:
        if n < 1 or n > self.npages:
            raise ValueError("pagina")
        return self.d[(n - 1) * self.ps:n * self.ps]

    def _header(self, n: int):
        p = self.page(n)
        off = 100 if n == 1 else 0
        if len(p) < off + 8:
            raise ValueError("pagina corta")
        flag = p[off]
        ncell = struct.unpack(">H", p[off + 3:off + 5])[0]
        hlen = 12 if flag in (2, 5) else 8
        right = struct.unpack(">I", p[off + 8:off + 12])[0] if hlen == 12 else 0
        ptrs = [struct.unpack(">H", p[off + hlen + 2 * k:off + hlen + 2 * k + 2])[0] for k in range(min(ncell, (len(p) - off - hlen) // 2))]
        return p, flag, ptrs, right

    def _payload(self, p: bytes, i: int, total: int) -> bytes:
        u = self.usable
        x = u - 35
        if total <= x:
            return p[i:i + total]
        m = ((u - 12) * 32 // 255) - 23
        k = m + ((total - m) % (u - 4))
        local = k if k <= x else m
        out = bytearray(p[i:i + local])
        nxt = struct.unpack(">I", p[i + local:i + local + 4])[0] if i + local + 4 <= len(p) else 0
        seen = set()
        while nxt and len(out) < total and nxt not in seen:
            seen.add(nxt)
            try:
                op = self.page(nxt)
            except ValueError:
                break
            self.visited.add(nxt)
            out += op[4:u][:total - len(out)]
            nxt = struct.unpack(">I", op[:4])[0]
        return bytes(out)

    def record(self, data: bytes) -> list:
        hsize, i = _varint(data, 0)
        types = []
        while i < hsize:
            t, i = _varint(data, i)
            types.append(t)
        pos = hsize
        vals = []
        for t in types:
            if t == 0:
                vals.append(None)
            elif 1 <= t <= 6:
                n = (1, 2, 3, 4, 6, 8)[t - 1]
                vals.append(_signed(int.from_bytes(data[pos:pos + n], "big"), n * 8) if pos + n <= len(data) else None)
                pos += n
            elif t == 7:
                vals.append(struct.unpack(">d", data[pos:pos + 8])[0] if pos + 8 <= len(data) else None)
                pos += 8
            elif t in (8, 9):
                vals.append(t - 8)
            elif t >= 12:
                n = (t - 12) // 2
                raw = data[pos:pos + n]
                pos += n
                vals.append(raw if t % 2 == 0 else raw.decode(self.enc, "replace"))
            else:
                vals.append(None)
        return vals

    def leaf_rows(self, n: int):
        p, flag, ptrs, _ = self._header(n)
        if flag != 13:
            return
        for c in ptrs:
            try:
                total, i = _varint(p, c)
                rowid, i = _varint(p, i)
                yield _signed(rowid, 64), self.record(self._payload(p, i, total))
            except Exception:  # noqa: BLE001 - cella rotta: si salta
                self.errors += 1

    def table(self, root: int):
        """Righe di una tabella seguendo il B-tree; le pagine rotte si saltano."""
        stack, seen = [root], set()
        while stack:
            n = stack.pop()
            if n in seen or n < 1 or n > self.npages:
                continue
            seen.add(n)
            try:
                p, flag, ptrs, right = self._header(n)
            except Exception:  # noqa: BLE001
                self.errors += 1
                continue
            if flag == 5:
                self.visited.add(n)
                kids = []
                for c in ptrs:
                    if c + 4 <= len(p):
                        kids.append(struct.unpack(">I", p[c:c + 4])[0])
                kids.append(right)
                stack.extend(reversed(kids))
            elif flag == 13:
                self.visited.add(n)
                yield from self.leaf_rows(n)
            else:
                self.errors += 1

    def leaves(self):
        for n in range(1, self.npages + 1):
            if n in self.visited:
                continue
            try:
                p = self.page(n)
                if p[100 if n == 1 else 0] == 13:
                    yield n
            except Exception:  # noqa: BLE001
                pass


def _q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def recover_python(src: str, out: str) -> dict:
    data = Path(src).read_bytes()
    r = Reader(data)
    Path(out).unlink(missing_ok=True)
    con = sqlite3.connect(out)
    tables, others, rows_total, lost = [], [], 0, 0
    try:
        master = []
        try:
            master = [v for _, v in r.table(1)]
        except Exception:  # noqa: BLE001
            r.errors += 1
        for v in master:
            if len(v) < 5 or not isinstance(v[4], str):
                continue
            typ, name, _tbl, root, sql = v[:5]
            if str(name).startswith("sqlite_"):
                continue
            if typ == "table" and isinstance(root, int) and root > 0:
                tables.append((name, root, sql))
            elif typ in ("index", "view", "trigger") and sql:
                others.append(sql)
        r.visited.add(1)
        recovered = []
        for name, root, sql in tables:
            try:
                con.execute(sql)
            except sqlite3.Error:
                continue
            cols = [c[1] for c in con.execute(f"PRAGMA table_info({_q(name)})")]
            pk = [c[1] for c in con.execute(f"PRAGMA table_info({_q(name)})") if c[5] == 1 and str(c[2]).upper() == "INTEGER"]
            n = 0
            ins = f"INSERT OR IGNORE INTO {_q(name)} (rowid, {', '.join(_q(c) for c in cols)}) VALUES ({', '.join('?' * (len(cols) + 1))})"
            for rowid, vals in r.table(root):
                vals = (list(vals) + [None] * len(cols))[:len(cols)]
                if pk:  # INTEGER PRIMARY KEY = alias del rowid: nel record vale NULL
                    k = cols.index(pk[0])
                    if vals[k] is None:
                        vals[k] = rowid
                try:
                    con.execute(ins, [rowid, *vals])
                    n += 1
                except sqlite3.Error:
                    r.errors += 1
            rows_total += n
            recovered.append({"tabella": name, "righe": n})
        # pagine foglia non raggiunte: righe orfane come in .recover
        orphan = []
        for pg in r.leaves():
            for rowid, vals in r.leaf_rows(pg):
                orphan.append((pg, rowid, vals))
        if orphan:
            width = max(len(v) for _, _, v in orphan)
            con.execute("CREATE TABLE lost_and_found (rootpgno INTEGER, pgno INTEGER, nfield INTEGER, id INTEGER, "
                        + ", ".join(f"c{i}" for i in range(width)) + ")")
            for pg, rowid, vals in orphan:
                con.execute(f"INSERT INTO lost_and_found VALUES ({', '.join('?' * (width + 4))})",
                            [None, pg, len(vals), rowid, *(list(vals) + [None] * width)[:width]])
            lost = len(orphan)
        for sql in others:
            try:
                con.execute(sql)
            except sqlite3.Error:
                pass
        con.commit()
    finally:
        con.close()
    return {"tabelle": recovered, "righe": rows_total, "orfane": lost, "errori": r.errors, "metodo": "interno"}


def recover_cli(exe: str, src: str, out: str) -> dict | None:
    """`.recover` di sqlite3.exe: SQL in uscita eseguito su un database nuovo."""
    try:
        r = subprocess.run([exe, src, ".recover"], capture_output=True, timeout=600, creationflags=NO_WINDOW)
    except Exception:  # noqa: BLE001
        return None
    if not r.stdout:
        return None
    Path(out).unlink(missing_ok=True)
    con = sqlite3.connect(out)
    try:
        con.executescript(r.stdout.decode("utf-8", "replace"))
        con.commit()
        names = [x[0] for x in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        tabs = [{"tabella": n, "righe": con.execute(f"SELECT COUNT(*) FROM {_q(n)}").fetchone()[0]} for n in names]
    except sqlite3.Error:
        con.close()
        return None
    con.close()
    lost = next((x["righe"] for x in tabs if x["tabella"] == "lost_and_found"), 0)
    tabs = [x for x in tabs if x["tabella"] != "lost_and_found"]
    return {"tabelle": tabs, "righe": sum(x["righe"] for x in tabs), "orfane": lost, "errori": 0, "metodo": "sqlite3 .recover"}


def recover(src: str, out: str) -> dict:
    exe = find_sqlite_cli()
    if exe:
        res = recover_cli(exe, src, out)
        if res is not None:
            return res
    return recover_python(src, out)
