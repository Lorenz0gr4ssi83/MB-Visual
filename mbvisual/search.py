"""Ricerca nel contenuto di tutti i file di una cartella di progetto.

Indice locale SQLite FTS5 per cartella in %LOCALAPPDATA%\\MBVisual\\indice (fuori da OneDrive), aggiornato in background
solo sui file cambiati (dimensione/data). I file "solo online" di OneDrive NON si leggono (leggerli li scaricherebbe):
si indicizzano nome e proprieta' finche' non sono sul PC, poi il contenuto al primo aggiornamento.
I DWG si leggono nell'interfaccia (libredwg, ui/js/search.js) e il testo arriva con `dwg_put`.
"""
import bisect
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

from . import search_extract as X
from .i18n import t
from .paths import DATA_DIR, TEMP_DIR

VERSION = 1  # versione degli estrattori: aumentarla fa rileggere tutti i file
BASE = DATA_DIR / "indice"
CLOUD_ATTRS = 0x400000 | 0x40000 | 0x1000  # RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE (come server._solo_online)
SKIP_DIRS = {"$recycle.bin", "system volume information", "node_modules", "__pycache__", ".git", ".svn", ".hg", ".vs", ".idea"}
SKIP_FILES = {"desktop.ini", "thumbs.db", ".ds_store"}
MAX_SIZE = {"ifc": 2048, "txt": 512, "log": 512, "csv": 512, "dxf": 600}  # MB oltre i quali si indicizza solo il nome
MAX_SIZE_DEFAULT = 300
SHIFT = 20  # rowid dei blocchi = id del file << 20 | numero del blocco
RESCAN = 120  # secondi tra due controlli automatici delle cartelle aperte

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, path TEXT UNIQUE, rel TEXT, folder TEXT, name TEXT, ext TEXT, kind TEXT,
  size INTEGER, mtime REAL, ctime REAL, state TEXT, note TEXT, ver INTEGER, nchunks INTEGER, indexed REAL);
CREATE INDEX IF NOT EXISTS files_folder ON files(folder);
CREATE INDEX IF NOT EXISTS files_state ON files(state);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, loc UNINDEXED, label UNINDEXED, pos UNINDEXED,
  tokenize="unicode61 remove_diacritics 2", prefix='3');
"""


def norm_root(p: str) -> str:
    return os.path.normpath(os.path.abspath(p))


def db_path(root: str) -> Path:
    return BASE / (hashlib.sha1(os.path.normcase(norm_root(root)).encode("utf-8")).hexdigest()[:16] + ".sqlite")


def connect(root: str) -> sqlite3.Connection:
    BASE.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path(root), timeout=30, check_same_thread=False)
    con.executescript(SCHEMA)
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("INSERT OR IGNORE INTO meta VALUES('root', ?)", (norm_root(root),))
    return con


def _cloud(st) -> bool:
    return bool(getattr(st, "st_file_attributes", 0) & CLOUD_ATTRS)


def find_root(folder: str) -> tuple[str, str]:
    """Cartella indicizzata da usare: se una cartella superiore ha gia' un indice si usa quello (con filtro sulla sottocartella)."""
    folder = norm_root(folder)
    p = Path(folder)
    for anc in [p, *p.parents]:
        if db_path(str(anc)).exists():
            rel = os.path.relpath(folder, str(anc)).replace("\\", "/")
            return str(anc), "" if rel == "." else rel
    return folder, ""


# ---------------------------------------------------------------- indicizzazione in background
class Indexer:
    def __init__(self, root: str):
        self.root = norm_root(root)
        self.lock = threading.Lock()
        self.thread = None
        self.again = False
        self.used = time.time()
        self.st = {"fase": "da avviare", "trovati": 0, "da_fare": 0, "fatti": 0, "corrente": "", "inizio": None, "fine": None,
                   "durata": None, "errore": None, "letti_mb": 0.0}

    def update(self, touch=True):
        if touch:
            self.used = time.time()
        with self.lock:
            if self.thread and self.thread.is_alive():
                self.again = True
                return
            self.thread = threading.Thread(target=self._loop, daemon=True, name="mbv-indice")
            self.thread.start()

    def _loop(self):
        while True:
            self.again = False
            try:
                self._run()
            except Exception as e:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                self.st.update(fase="errore", errore=str(e))
            if not self.again:
                return

    def _walk(self):
        stack = [self.root]
        idx = os.path.normcase(str(BASE))
        while stack:
            d = stack.pop()
            try:
                it = os.scandir(d)
            except OSError:
                continue
            with it:
                for e in it:
                    name = e.name
                    low = name.lower()
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if low in SKIP_DIRS or name.startswith(".") or os.path.normcase(e.path) == idx:
                                continue
                            if e.is_junction() if hasattr(e, "is_junction") else False:
                                continue
                            stack.append(e.path)
                            continue
                        if not e.is_file(follow_symlinks=False) or low in SKIP_FILES or name.startswith(("~$", ".~lock")) or low.endswith((".tmp", ".mbv-tmp")):
                            continue
                        yield e.path, e.stat(follow_symlinks=False)
                    except OSError:
                        continue

    def _run(self):
        t0, c0 = time.time(), time.thread_time()
        st = self.st
        st.update(fase="scansione", fatti=0, da_fare=0, corrente="", inizio=t0, errore=None, letti_mb=0.0)
        con = connect(self.root)
        try:
            known = {r[0]: r[1:] for r in con.execute("SELECT path, id, size, mtime, state, ver FROM files")}
            seen, todo = set(), []
            n = 0
            for path, s in self._walk():
                n += 1
                if n % 500 == 0:
                    st["trovati"] = n
                seen.add(path)
                cloud = _cloud(s)
                k = known.get(path)
                if k:
                    _id, size, mtime, state, ver = k
                    same = size == s.st_size and abs((mtime or 0) - s.st_mtime) < 0.001 and ver == VERSION
                    # invariato: si salta (anche se OneDrive lo ha "liberato": il contenuto indicizzato resta valido),
                    # tranne i file prima solo online e ora sul PC, di cui si legge finalmente il contenuto
                    if same and not (state == "nuvola" and not cloud):
                        continue
                todo.append((path, s, cloud))
            st["trovati"] = n
            gone = [k[0] for p, k in known.items() if p not in seen]
            for fid in gone:
                _delete(con, fid)
            con.commit()
            # prima i file piccoli e recenti: i risultati utili arrivano subito
            todo.sort(key=lambda x: (x[1].st_size > 20 * 1024 * 1024, -x[1].st_mtime))
            st.update(fase="indicizzazione" if todo else "pronto", da_fare=len(todo), rimossi=len(gone))
            last = time.time()
            tmp = TEMP_DIR / "indice"
            tmp.mkdir(parents=True, exist_ok=True)
            for i, (path, s, cloud) in enumerate(todo):
                st.update(corrente=os.path.relpath(path, self.root), fatti=i)
                self._index_one(con, path, s, cloud, str(tmp))
                if time.time() - last > 2:
                    con.commit()
                    last = time.time()
                time.sleep(0)  # lascia respirare le richieste dell'interfaccia
            con.commit()
            con.execute("INSERT OR REPLACE INTO meta VALUES('ultimo', ?)", (str(time.time()),))
            con.commit()
            if todo and len(todo) > 200:
                con.execute("INSERT INTO chunks(chunks) VALUES('optimize')")
                con.commit()
        finally:
            con.close()
        st.update(fase="pronto", fatti=st["da_fare"], corrente="", fine=time.time(), durata=round(time.time() - t0, 2), cpu=round(time.thread_time() - c0, 1))

    def _index_one(self, con, path, s, cloud, tmp):
        rel = os.path.relpath(path, self.root).replace("\\", "/")
        name = os.path.basename(path)
        ext = os.path.splitext(name)[1].lower().lstrip(".")
        folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
        kind = X.kind_of(ext)
        row = con.execute("SELECT id FROM files WHERE path=?", (path,)).fetchone()
        if row:
            fid = row[0]
            _delete_chunks(con, fid)
        else:
            fid = con.execute("INSERT INTO files(path) VALUES(?)", (path,)).lastrowid
        out, state, note = X.Out(), "ok", None
        limit = MAX_SIZE.get(ext, MAX_SIZE_DEFAULT) * 1024 * 1024
        if cloud:
            state, note = "nuvola", X.L("nota_nuvola")
        elif ext == "dwg" or ext == "dwt":
            state = "dwg"  # testo letto dall'interfaccia (libredwg): vedi dwg_pending / dwg_put
        elif s.st_size > limit:
            state, note = "nome", X.L("nota_troppo_grande", round(s.st_size / 1048576))
        else:
            try:
                out = X.extract(path, ext, tmp)
                note = out.note
                self.st["letti_mb"] = round(self.st.get("letti_mb", 0) + s.st_size / 1048576, 1)
                if not out.chunks and kind == "altro":
                    state = "nome"
            except Exception as e:  # noqa: BLE001
                state, note = "errore", X.L("nota_errore", str(e)[:200] or e.__class__.__name__)
                out = X.Out()
        _write(con, fid, path, rel, folder, name, ext, kind, s, state, note, out)


def _meta_text(name, rel, ext, meta):
    base = os.path.splitext(name)[0]
    spaced = re.sub(r"[_\-.]+", " ", base)
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])", " ", spaced)
    lines = [name, spaced, rel, ext]
    lines += [f"{t('srv_search.meta_' + k) if k.isidentifier() else k}: {v}" for k, v in meta.items() if v]
    return "\n".join(lines)


def _write(con, fid, path, rel, folder, name, ext, kind, s, state, note, out):
    base = fid << SHIFT
    rows = [(base, _meta_text(name, rel, ext, out.meta), json.dumps({"meta": True}), X.L("nome_proprieta"), None)]
    for i, (loc, label, text, pos) in enumerate(out.chunks[: (1 << SHIFT) - 2], 1):
        rows.append((base + i, text, json.dumps(loc or {}, ensure_ascii=False), label, json.dumps(pos, ensure_ascii=False) if pos else None))
    con.executemany("INSERT INTO chunks(rowid, text, loc, label, pos) VALUES(?,?,?,?,?)", rows)
    con.execute("""UPDATE files SET rel=?, folder=?, name=?, ext=?, kind=?, size=?, mtime=?, ctime=?, state=?, note=?, ver=?, nchunks=?, indexed=?
                   WHERE id=?""", (rel, folder, name, ext, kind, s.st_size, s.st_mtime, getattr(s, "st_birthtime", s.st_ctime), state, note,
                                   VERSION, len(rows), time.time(), fid))


def _delete_chunks(con, fid):
    con.execute("DELETE FROM chunks WHERE rowid BETWEEN ? AND ?", (fid << SHIFT, ((fid + 1) << SHIFT) - 1))


def _delete(con, fid):
    _delete_chunks(con, fid)
    con.execute("DELETE FROM files WHERE id=?", (fid,))


_IDX: dict[str, Indexer] = {}
_LOCK = threading.Lock()
_WATCH = {"t": None}


def indexer(root: str) -> Indexer:
    key = os.path.normcase(norm_root(root))
    with _LOCK:
        ix = _IDX.get(key)
        if not ix:
            ix = _IDX[key] = Indexer(root)
        if not _WATCH["t"]:
            _WATCH["t"] = threading.Thread(target=_watch, daemon=True, name="mbv-indice-controllo")
            _WATCH["t"].start()
    return ix


def _watch():
    # le cartelle cercate nell'ultima ora si ricontrollano da sole: si rileggono solo i file cambiati
    while True:
        time.sleep(RESCAN)
        for ix in list(_IDX.values()):
            if time.time() - ix.used < 3600:
                t = ix.thread
                if not (t and t.is_alive()):
                    ix.update(touch=False)


# ---------------------------------------------------------------- API
def update(folder: str) -> dict:
    root, sub = find_root(folder)
    indexer(root).update()
    return status(folder)


def status(folder: str) -> dict:
    root, sub = find_root(folder)
    ix = indexer(root)
    res = {"ok": True, "root": root, "sotto": sub, **ix.st}
    p = db_path(root)
    if p.exists():
        con = connect(root)
        try:
            counts = dict(con.execute("SELECT state, count(*) FROM files GROUP BY state").fetchall())
            res["file"] = sum(counts.values())
            res["stati"] = counts
            u = con.execute("SELECT v FROM meta WHERE k='ultimo'").fetchone()
            res["ultimo"] = float(u[0]) if u else None
        finally:
            con.close()
        res["dimensione"] = sum(f.stat().st_size for f in p.parent.glob(p.name + "*"))
    return res


def files_in_state(folder: str, state: str, limit: int = 500) -> dict:
    root, sub = find_root(folder)
    con = connect(root)
    try:
        rows = con.execute("SELECT path, rel, size, mtime, note FROM files WHERE state=? ORDER BY rel LIMIT ?", (state, limit)).fetchall()
    finally:
        con.close()
    return {"ok": True, "items": [{"path": r[0], "rel": r[1], "size": r[2], "mtime": r[3], "note": tr_label(r[4])} for r in rows]}


def folders(folder: str) -> dict:
    root, sub = find_root(folder)
    con = connect(root)
    try:
        rows = [r[0] for r in con.execute("SELECT DISTINCT folder FROM files WHERE folder != '' ORDER BY folder")]
    finally:
        con.close()
    # cartelle di primo e secondo livello (anche quelle che contengono solo sottocartelle)
    out = set()
    for f in rows:
        parts = f.split("/")
        for n in (1, 2):
            if len(parts) >= n:
                out.add("/".join(parts[:n]))
    return {"ok": True, "root": root, "sotto": sub, "folders": sorted(out, key=str.lower)}


def rebuild(folder: str) -> dict:
    root, sub = find_root(folder)
    ix = indexer(root)
    if ix.thread and ix.thread.is_alive():
        return {"ok": False, "errore": t("srv_search.indicizzazione_in_corso")}
    p = db_path(root)
    for f in p.parent.glob(p.name + "*"):
        try:
            f.unlink()
        except OSError:
            pass
    ix.update()
    return {"ok": True}


# ---------------------------------------------------------------- DWG letti nell'interfaccia
def dwg_pending(folder: str, limit: int = 5) -> dict:
    root, sub = find_root(folder)
    con = connect(root)
    try:
        rows = con.execute("SELECT path, size, mtime FROM files WHERE state='dwg' ORDER BY size LIMIT ?", (limit,)).fetchall()
        left = con.execute("SELECT count(*) FROM files WHERE state='dwg'").fetchone()[0]
    finally:
        con.close()
    return {"ok": True, "items": [{"path": r[0], "size": r[1], "mtime": r[2]} for r in rows], "restanti": left}


def dwg_put(folder: str, b: dict) -> dict:
    root, sub = find_root(folder)
    path = b["path"]
    con = connect(root)
    try:
        r = con.execute("SELECT id, size, mtime, rel, folder, name, ext, kind, ctime FROM files WHERE path=? AND state='dwg'", (path,)).fetchone()
        if not r:
            return {"ok": True, "ignorato": True}
        fid, size, mtime, rel, fold, name, ext, kind, ctime = r
        if size != b.get("size") or abs((mtime or 0) - float(b.get("mtime") or 0)) > 0.001:
            return {"ok": True, "ignorato": True}  # cambiato nel frattempo: lo riprende la prossima scansione
        out = X.Out()
        state, note = "ok", None
        if b.get("errore"):
            state, note = "errore", X.L("nota_dwg_errore", str(b["errore"])[:200])
        else:
            X.dwg_items(b.get("items") or [], b.get("layers") or [], b.get("blocks") or [], out)
            note = out.note
        _delete_chunks(con, fid)

        class S:  # dati del file come os.stat (non cambiati)
            st_size, st_mtime, st_ctime = size, mtime, ctime
        _write(con, fid, path, rel, fold, name, ext, kind, S, state, note, out)
        con.commit()
    finally:
        con.close()
    return {"ok": True}


# ---------------------------------------------------------------- ricerca
_TOK = re.compile(r'(-?)"([^"]*)"?|(\S+)')
_WORD = re.compile(r"\w+", re.UNICODE)


def fts_query(q: str) -> tuple[str, list[str]]:
    """Ricerca dell'utente -> espressione FTS5. "frase esatta", prefisso*, piu' parole (tutte), OR, -escludi."""
    pos, neg, terms = [], [], []
    pending_or = False
    for m in _TOK.finditer(q or ""):
        if m.group(3) is not None:
            w = m.group(3)
            if w.upper() == "OR" or w == "|":
                pending_or = bool(pos)
                continue
            minus = w.startswith("-") and len(w) > 1
            if minus:
                w = w[1:]
            prefix = w.endswith("*")
            parts = _WORD.findall(w)
        else:
            minus, prefix = m.group(1) == "-", False
            parts = _WORD.findall(m.group(2))
        if not parts:
            continue
        t = '"' + " ".join(parts) + '"' + ("*" if prefix else "")
        if minus:
            neg.append(t)
            continue
        terms.append(" ".join(parts))
        if pending_or and pos:
            pos[-1] = f"({pos[-1]} OR {t})"
        else:
            pos.append(t)
        pending_or = False
    if not pos:
        return "", []
    expr = " AND ".join(pos)
    if neg:
        expr = f"({expr}) NOT ({' OR '.join(neg)})"
    return expr, terms


def _filters(kind, folder, dfrom, dto):
    where, args = [], []
    if kind:
        kinds = [k for k in kind.split(",") if k]
        where.append("f.kind IN (%s)" % ",".join("?" * len(kinds)))
        args += kinds
    if folder:
        folder = folder.strip("/")
        where.append("(f.folder = ? OR substr(f.folder, 1, ?) = ?)")
        args += [folder, len(folder) + 1, folder + "/"]
    if dfrom:
        where.append("f.mtime >= ?")
        args.append(float(dfrom))
    if dto:
        where.append("f.mtime < ?")
        args.append(float(dto))
    return where, args


def _precise(con, match, rowid, loc, pos):
    """Dal blocco trovato al punto preciso: riga del testo, cella, entita' CAD, elemento IFC; e la parola trovata."""
    h = con.execute("SELECT highlight(chunks, 0, char(2), char(3)) FROM chunks WHERE chunks MATCH ? AND rowid = ?", (match, rowid)).fetchone()
    if not h or not h[0]:
        return loc, None
    h = h[0]
    # parole evidenziate con la loro posizione nel testo originale (senza i segni)
    marks, plain, k = [], 0, 0
    while True:
        i = h.find("\x02", k)
        if i < 0:
            break
        j = h.find("\x03", i)
        if j < 0:
            break
        start = i - 2 * len(marks)
        marks.append((start, h[i + 1:j]))
        k = j + 1
    if not marks:
        return loc, None
    plain = h.replace("\x02", "").replace("\x03", "")
    loc = dict(loc)
    # voce (riga, cella, entita', elemento) con piu' parole diverse della ricerca; a parita' la prima
    if pos:
        unit = lambda o: bisect.bisect_right(pos["o"], o) - 1  # noqa: E731
    else:
        unit = lambda o: plain.count("\n", 0, o)  # noqa: E731
    groups = {}
    for o, t in marks:
        groups.setdefault(unit(o), {})[t.lower()] = (o, t)
    best = max(groups.items(), key=lambda kv: (len(kv[1]), -kv[0]))
    o, term = min(best[1].values())
    if "line" in loc:
        loc["line"] = int(loc["line"]) + plain.count("\n", 0, o)
    if pos and best[0] >= 0:
        loc[pos["k"]] = pos["v"][best[0]]
    return loc, term


def search(folder: str, q: str, kind: str = "", sub: str = "", dfrom=None, dto=None, max_files: int = 200, per_file: int = 3) -> dict:
    t0 = time.time()
    root, base_sub = find_root(folder)
    sub = "/".join(x for x in (base_sub, (sub or "").strip("/")) if x)
    match, terms = fts_query(q)
    where, args = _filters(kind, sub, dfrom, dto)
    con = connect(root)
    try:
        if not match:
            if not where:
                return {"ok": True, "root": root, "files": [], "totale": 0, "ms": 0, "termini": []}
            # solo filtri: file che corrispondono, piu' recenti per primi
            rows = con.execute(f"SELECT f.id, f.path, f.rel, f.name, f.ext, f.kind, f.size, f.mtime, f.state, f.note FROM files f WHERE {' AND '.join(where)} "
                               "ORDER BY f.mtime DESC LIMIT ?", (*args, max_files)).fetchall()
            files = [_file(r, []) for r in rows]
            tot = con.execute(f"SELECT count(*) FROM files f WHERE {' AND '.join(where)}", args).fetchone()[0]
            return {"ok": True, "root": root, "files": files, "totale": tot, "ms": round((time.time() - t0) * 1000), "termini": []}
        sql = (f"SELECT c.rowid, c.loc, c.label, c.pos, snippet(chunks, 0, char(2), char(3), '…', 20), bm25(chunks) AS r, "
               f"f.id, f.path, f.rel, f.name, f.ext, f.kind, f.size, f.mtime, f.state, f.note "
               f"FROM chunks c JOIN files f ON f.id = (c.rowid >> {SHIFT}) WHERE chunks MATCH ? {''.join(' AND ' + w for w in where)} "
               f"ORDER BY r LIMIT 5000")
        try:
            rows = con.execute(sql, (match, *args)).fetchall()
        except sqlite3.OperationalError as e:
            return {"ok": False, "errore": t("srv_search.ricerca_non_valida", e)}
        byfile, order, allf = {}, [], set()
        for r in rows:
            fid = r[6]
            allf.add(fid)
            if fid not in byfile:
                if len(order) >= max_files:
                    continue
                byfile[fid] = {"row": r[6:], "hits": [], "n": 0}
                order.append(fid)
            g = byfile[fid]
            g["n"] += 1
            if len(g["hits"]) < per_file:
                g["hits"].append(r[:5])
        files = []
        for fid in order:
            g = byfile[fid]
            hits = []
            for rowid, loc, label, pos, snip in g["hits"]:
                loc = json.loads(loc or "{}")
                pos = json.loads(pos) if pos else None
                term = None
                if pos or "line" in loc or not loc.get("meta"):
                    loc, term = _precise(con, match, rowid, loc, pos)
                hits.append({"loc": loc, "label": _label(label, loc), "snippet": snip, "term": term})
            files.append(_file(g["row"], hits, g["n"]))
        tot = len(allf) if len(rows) < 5000 else con.execute(
            f"SELECT count(DISTINCT c.rowid >> {SHIFT}) FROM chunks c JOIN files f ON f.id = (c.rowid >> {SHIFT}) WHERE chunks MATCH ? "
            f"{''.join(' AND ' + w for w in where)}", (match, *args)).fetchone()[0]
    finally:
        con.close()
    return {"ok": True, "root": root, "files": files, "totale": tot, "ms": round((time.time() - t0) * 1000), "termini": terms}


def tr_label(v):
    """Etichette e avvisi salvati come chiave (search_extract.L) -> testo nella lingua dell'interfaccia."""
    if isinstance(v, str) and v.startswith('["srv_'):
        try:
            k, *args = json.loads(v)
        except ValueError:
            return v
        return t(k, *[tr_label(a) for a in args])
    return v


def _label(label, loc):
    extra = []
    if loc.get("cell"):
        extra.append(t("srv_search.pos_cella", loc["cell"]))
    if loc.get("line"):
        extra.append(t("srv_search.pos_riga", loc["line"]))
    if loc.get("ifc"):
        extra.append(t("srv_search.pos_elemento", loc["ifc"]))
    if loc.get("handle"):
        extra.append(t("srv_search.pos_handle", loc["handle"]))
    return tr_label(label or "") + (" · " + ", ".join(extra) if extra else "")


def _file(r, hits, n=0):
    fid, path, rel, name, ext, kind, size, mtime, state, note = r
    return {"path": path, "rel": rel, "name": name, "ext": ext, "kind": kind, "size": size, "mtime": mtime, "state": state,
            "note": tr_label(note), "hits": hits, "n": n}
