"""Archivio locale della posta (si legge anche senza rete).

- Indice: database SQLite IN MEMORIA, salvato cifrato (vault.seal) in posta/indice.bin pochi secondi dopo ogni modifica
  e alla chiusura. Contiene cartelle, intestazioni, stati, testo per la ricerca (FTS5), commesse, regole, uscita,
  calendari e contatti. Nessun dato leggibile su disco.
- Messaggi completi (RFC 822): un file cifrato per messaggio in posta/msg/<aa>/<sha256>.bin (stesso contenuto = stesso file).
"""
import atexit
import hashlib
import json
import sqlite3
import threading
import time

from . import vault

DB_FILE = vault.DATA_DIR / "indice.bin"
MSG_DIR = vault.DATA_DIR / "msg"
VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS folders(
  id INTEGER PRIMARY KEY, account TEXT, path TEXT, name TEXT, role TEXT DEFAULT '', delim TEXT DEFAULT '/',
  uidvalidity INTEGER DEFAULT 0, uidnext INTEGER DEFAULT 0, remote_id TEXT DEFAULT '', delta TEXT DEFAULT '',
  noselect INTEGER DEFAULT 0, synced REAL DEFAULT 0, UNIQUE(account, path));
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, account TEXT, folder_id INTEGER, uid INTEGER DEFAULT 0, remote_id TEXT DEFAULT '',
  msgid TEXT DEFAULT '', in_reply_to TEXT DEFAULT '', refs TEXT DEFAULT '', thread TEXT DEFAULT '',
  subject TEXT DEFAULT '', from_name TEXT DEFAULT '', from_addr TEXT DEFAULT '', to_json TEXT DEFAULT '[]', cc_json TEXT DEFAULT '[]',
  date REAL DEFAULT 0, size INTEGER DEFAULT 0, seen INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, answered INTEGER DEFAULT 0,
  forwarded INTEGER DEFAULT 0, draft INTEGER DEFAULT 0, has_att INTEGER DEFAULT 0, att_json TEXT DEFAULT '[]', preview TEXT DEFAULT '',
  blob TEXT DEFAULT '', categories TEXT DEFAULT '[]', flag_due REAL DEFAULT 0, flag_done INTEGER DEFAULT 0, remind_at REAL DEFAULT 0,
  commessa TEXT DEFAULT '', pec TEXT DEFAULT '', pec_ref TEXT DEFAULT '', pec_json TEXT DEFAULT '', invite INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 0, added REAL DEFAULT 0, gone INTEGER DEFAULT 0, nsubj TEXT DEFAULT '', pec_state TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS m_folder ON messages(folder_id, date);
CREATE INDEX IF NOT EXISTS m_uid ON messages(folder_id, uid);
CREATE INDEX IF NOT EXISTS m_msgid ON messages(msgid);
CREATE INDEX IF NOT EXISTS m_thread ON messages(thread);
CREATE INDEX IF NOT EXISTS m_pecref ON messages(pec_ref);
CREATE INDEX IF NOT EXISTS m_commessa ON messages(commessa);
CREATE INDEX IF NOT EXISTS m_nsubj ON messages(account, nsubj);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(subject, people, body, atts, tokenize='unicode61 remove_diacritics 2', prefix='3');
CREATE TABLE IF NOT EXISTS ops(id INTEGER PRIMARY KEY, account TEXT, kind TEXT, args TEXT, tries INTEGER DEFAULT 0, error TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, account TEXT, send_at REAL, created REAL, blob TEXT, subject TEXT,
  rcpt TEXT, status TEXT DEFAULT 'attesa', error TEXT DEFAULT '', draft_id INTEGER DEFAULT 0, info TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS commesse(id TEXT PRIMARY KEY, nome TEXT, codice TEXT DEFAULT '', cartella TEXT DEFAULT '',
  parole TEXT DEFAULT '[]', indirizzi TEXT DEFAULT '[]', colore TEXT DEFAULT '', creata REAL DEFAULT 0, chiusa INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS rules(id INTEGER PRIMARY KEY, nome TEXT, account TEXT DEFAULT '*', attiva INTEGER DEFAULT 1,
  cond TEXT DEFAULT '{}', azioni TEXT DEFAULT '{}', ord INTEGER DEFAULT 0, stop INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS calendars(id INTEGER PRIMARY KEY, account TEXT, href TEXT, name TEXT, color TEXT DEFAULT '',
  ctag TEXT DEFAULT '', kind TEXT DEFAULT 'cal', readonly INTEGER DEFAULT 0, UNIQUE(account, href));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, cal_id INTEGER, href TEXT DEFAULT '', etag TEXT DEFAULT '', uid TEXT,
  summary TEXT DEFAULT '', location TEXT DEFAULT '', start REAL, end REAL, allday INTEGER DEFAULT 0, rrule TEXT DEFAULT '',
  ics TEXT DEFAULT '', dirty INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS e_cal ON events(cal_id, start);
CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY, book_id INTEGER DEFAULT 0, href TEXT DEFAULT '', etag TEXT DEFAULT '',
  uid TEXT, name TEXT DEFAULT '', emails TEXT DEFAULT '[]', phones TEXT DEFAULT '[]', org TEXT DEFAULT '', vcf TEXT DEFAULT '',
  dirty INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, used INTEGER DEFAULT 0, last REAL DEFAULT 0);
CREATE INDEX IF NOT EXISTS c_name ON contacts(name);
"""


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.dirty = False
        self.saved_at = 0.0
        self.con = sqlite3.connect(":memory:", check_same_thread=False)
        self.con.row_factory = sqlite3.Row
        if DB_FILE.exists():
            try:
                self.con.deserialize(vault.read(DB_FILE, b"indice"))
            except Exception:  # noqa: BLE001 - indice rovinato: si conserva e si riparte (i messaggi cifrati restano)
                DB_FILE.replace(DB_FILE.with_suffix(f".rovinato-{int(time.time())}"))
        self.con.executescript(SCHEMA)
        self.con.execute("INSERT OR IGNORE INTO meta VALUES('version', ?)", (str(VERSION),))
        self._stop = threading.Event()
        threading.Thread(target=self._saver, daemon=True).start()
        atexit.register(self.flush)

    # ---------------------------------------------------------- accesso
    def q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.con.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        with self.lock:
            r = self.con.execute(sql, args).fetchone()
            return dict(r) if r else None

    def x(self, sql, args=()):
        with self.lock:
            cur = self.con.execute(sql, args)
            self.dirty = True
            return cur.lastrowid if cur.lastrowid else cur.rowcount

    def many(self, sql, rows):
        with self.lock:
            self.con.executemany(sql, rows)
            self.dirty = True

    def setting(self, k, default=None):
        r = self.one("SELECT v FROM settings WHERE k=?", (k,))
        return json.loads(r["v"]) if r else default

    def set_setting(self, k, v):
        self.x("INSERT OR REPLACE INTO settings VALUES(?, ?)", (k, json.dumps(v)))

    # ---------------------------------------------------------- salvataggio cifrato
    def flush(self):
        with self.lock:
            if not self.dirty:
                return
            data = self.con.serialize()
            self.dirty = False
        vault.write(DB_FILE, data, b"indice")
        self.saved_at = time.time()

    def _saver(self):
        while not self._stop.wait(3):
            try:
                self.flush()
            except Exception:  # noqa: BLE001
                import traceback
                traceback.print_exc()

    # ---------------------------------------------------------- messaggi completi
    @staticmethod
    def _blob_path(h):
        return MSG_DIR / h[:2] / (h + ".bin")

    def put_raw(self, raw: bytes) -> str:
        h = hashlib.sha256(raw).hexdigest()
        p = self._blob_path(h)
        if not p.exists():
            vault.write(p, raw, h.encode())
        return h

    def get_raw(self, h: str) -> bytes | None:
        p = self._blob_path(h)
        if not h or not p.exists():
            return None
        return vault.read(p, h.encode())

    def drop_raw(self, h: str):
        if not h:
            return
        if self.one("SELECT 1 FROM messages WHERE blob=? LIMIT 1", (h,)) or self.one("SELECT 1 FROM outbox WHERE blob=? LIMIT 1", (h,)):
            return
        try:
            self._blob_path(h).unlink()
        except OSError:
            pass


_STORE = None
_SLOCK = threading.Lock()


def get() -> Store:
    global _STORE
    with _SLOCK:
        if _STORE is None:
            _STORE = Store()
        return _STORE
