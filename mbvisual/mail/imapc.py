"""Client IMAP4rev1 (imaplib della libreria standard) con autenticazione a password o XOAUTH2 (Gmail, Microsoft)."""
import base64
import imaplib
import re

from . import accounts
from ..i18n import t

imaplib._MAXLINE = 50_000_000  # righe lunghe (elenchi di UID di cartelle grandi)


class MailError(Exception):
    def __init__(self, msg, auth=False, offline=False):
        super().__init__(msg)
        self.auth = auth          # credenziali rifiutate
        self.offline = offline    # rete o server non raggiungibili


# ------------------------------------------------------------------ UTF-7 modificato (RFC 3501, nomi delle cartelle)
def utf7_decode(s: str) -> str:
    def rep(m):
        x = m.group(1)
        if not x:
            return "&"
        b = x.replace(",", "/")
        b += "=" * (-len(b) % 4)
        return base64.b64decode(b).decode("utf-16-be", "replace")
    return re.sub(r"&([A-Za-z0-9+,]*)-", rep, s)


def utf7_encode(s: str) -> str:
    out, buf = [], []

    def flush():
        if buf:
            b = base64.b64encode("".join(buf).encode("utf-16-be")).decode().rstrip("=").replace("/", ",")
            out.append("&" + b + "-")
            buf.clear()
    for ch in s:
        if 0x20 <= ord(ch) <= 0x7e:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


def q(name: str) -> str:
    """Nome di cartella per un comando IMAP (UTF-7 modificato, tra virgolette)."""
    return '"' + utf7_encode(name).replace("\\", "\\\\").replace('"', '\\"') + '"'


# ------------------------------------------------------------------ lettura delle risposte FETCH
_TOK = re.compile(rb'\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|\x00L(\d+)\x00|([^\s()"\x00\[]+(?:\[[^\]]*\][^\s()"\x00]*)?))', re.S)


def _parse_list(buf, pos, lits):
    out = []
    while pos < len(buf):
        m = _TOK.match(buf, pos)
        if not m:
            break
        pos = m.end()
        if m.group(1):
            sub, pos = _parse_list(buf, pos, lits)
            out.append(sub)
        elif m.group(2):
            return out, pos
        elif m.group(3) is not None:
            out.append(re.sub(rb"\\(.)", rb"\1", m.group(3)))
        elif m.group(4):
            out.append(lits[int(m.group(4))])
        else:
            out.append(m.group(5))
    return out, pos


def parse_fetch(data) -> list:
    """Dati di imaplib per FETCH -> [{b'UID': b'5', b'FLAGS': [...], b'BODY[]': bytes, ...}]."""
    buf, lits = b"", []
    for item in data:
        if isinstance(item, tuple):
            head = re.sub(rb"\{\d+\}$", b"", item[0])
            lits.append(item[1])
            buf += head + b"\x00L%d\x00" % (len(lits) - 1)
        elif isinstance(item, bytes):
            buf += item + b" "
    items, _ = _parse_list(buf, 0, lits)
    out = []
    i = 0
    while i < len(items):
        if isinstance(items[i], bytes) and items[i].isdigit() and i + 1 < len(items) and isinstance(items[i + 1], list):
            lst = items[i + 1]
            d = {}
            for k in range(0, len(lst) - 1, 2):
                key = lst[k].upper() if isinstance(lst[k], bytes) else b""
                key = key.replace(b".PEEK", b"")
                d[key] = lst[k + 1]
            d[b"SEQ"] = int(items[i])
            out.append(d)
            i += 2
        else:
            i += 1
    return out


def flags_of(v) -> set:
    return {f.decode("ascii", "replace").lower() for f in (v or []) if isinstance(f, bytes)}


# ------------------------------------------------------------------ connessione
class Imap:
    def __init__(self, acc: dict, token_fn=None, timeout=60):
        self.acc = acc
        host, port, sec = acc.get("imap"), int(acc.get("imap_port") or 993), acc.get("imap_sec", "ssl")
        if not host:
            raise MailError(t("srv_mail.server_imap_mancante"))
        insecure = bool(acc.get("_insicuro"))
        try:
            if sec == "ssl":
                self.c = imaplib.IMAP4_SSL(host, port, ssl_context=accounts.tls_context(insecure), timeout=timeout)
            else:
                self.c = imaplib.IMAP4(host, port, timeout=timeout)
                if sec == "starttls":
                    self.c.starttls(accounts.tls_context(insecure))
        except (OSError, imaplib.IMAP4.error) as e:
            raise MailError(t("srv_mail.server_non_raggiungibile", f"{host}:{port}", e), offline=True) from e
        user = acc.get("utente") or acc.get("email")
        try:
            if token_fn:
                tok = token_fn()
                self.c.authenticate("XOAUTH2", lambda _: f"user={user}\x01auth=Bearer {tok}\x01\x01".encode())
            else:
                pw = accounts.secret(acc["id"]).get("password") if acc.get("id") else acc.get("_password")
                pw = acc.get("_password") or pw
                if not pw:
                    raise MailError(t("srv_mail.password_mancante"), auth=True)
                self.c.login(user, pw)
        except imaplib.IMAP4.error as e:
            try:
                self.c.shutdown()
            except Exception:  # noqa: BLE001
                pass
            raise MailError(t("srv_mail.accesso_rifiutato", _clean(e)), auth=True) from e
        self.caps = {c.upper() for c in self.c.capabilities}
        self.selected = None

    def close(self):
        try:
            self.c.logout()
        except Exception:  # noqa: BLE001
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def _ok(self, typ, data, what=""):
        if typ != "OK":
            raise MailError(t("srv_mail.comando_imap_fallito", what, _clean(data)))
        return data

    # ---------------------------------------------------------- cartelle
    def folders(self) -> list:
        """[{path, name, delim, flags, role}] con i ruoli SPECIAL-USE (RFC 6154) o dai nomi tipici."""
        typ, data = self.c.list()
        self._ok(typ, data, "LIST")
        out = []
        for line in data:
            if not line:
                continue
            if isinstance(line, tuple):
                line = line[0] + b'"' + line[1].replace(b'"', b'\\"') + b'"'
            m = re.match(rb'\((.*?)\)\s+("(?:[^"\\]|\\.)*"|NIL)\s+(.*)$', line)
            if not m:
                continue
            flags = {f.lower() for f in m.group(1).decode("ascii", "replace").split()}
            delim = m.group(2).strip(b'"').decode() if m.group(2) != b"NIL" else "/"
            delim = delim.replace("\\\\", "\\")
            raw = m.group(3).strip()
            if raw.startswith(b'"'):
                raw = re.sub(rb"\\(.)", rb"\1", raw[1:-1])
            path = utf7_decode(raw.decode("utf-8", "replace"))
            out.append({"path": path, "name": path.split(delim)[-1] if delim else path, "delim": delim,
                        "flags": sorted(flags), "role": role_of(path, flags)})
        return out

    def select(self, path, readonly=False):
        typ, data = self.c.select(q(path), readonly=readonly)
        self._ok(typ, data, "SELECT " + path)
        self.selected = path
        uv = self.c.response("UIDVALIDITY")[1]
        un = self.c.response("UIDNEXT")[1]
        return {"exists": int(data[0] or 0), "uidvalidity": int(uv[0]) if uv and uv[0] else 0,
                "uidnext": int(un[0]) if un and un[0] else 0}

    def uids(self, criteria="ALL") -> list:
        typ, data = self.c.uid("SEARCH", None, criteria)
        self._ok(typ, data, "SEARCH")
        return [int(x) for x in b" ".join(d for d in data if d).split()]

    def fetch(self, uids, what: str) -> list:
        if not uids:
            return []
        out = []
        for i in range(0, len(uids), 400):
            seq = _seq(uids[i:i + 400])
            typ, data = self.c.uid("FETCH", seq, f"({what})")
            self._ok(typ, data, "FETCH")
            out.extend(parse_fetch(data))
        return out

    def store(self, uids, op: str, flags: str):
        if uids:
            typ, data = self.c.uid("STORE", _seq(uids), op, f"({flags})")
            self._ok(typ, data, "STORE")

    def move(self, uids, dest: str) -> dict:
        """Sposta; restituisce {vecchio uid: nuovo uid} se il server lo dice (UIDPLUS)."""
        if not uids:
            return {}
        if "MOVE" in self.caps:
            typ, data = self.c.uid("MOVE", _seq(uids), q(dest))
            self._ok(typ, data, "MOVE")
            resp = self.c.response("COPYUID")[1]
        else:
            typ, data = self.c.uid("COPY", _seq(uids), q(dest))
            self._ok(typ, data, "COPY")
            resp = self.c.response("COPYUID")[1]
            self.store(uids, "+FLAGS.SILENT", "\\Deleted")
            self.expunge(uids)
        return _copyuid(resp, data)

    def expunge(self, uids=None):
        if uids and "UIDPLUS" in self.caps:
            self.c.uid("EXPUNGE", _seq(uids))
        else:
            self.c.expunge()

    def append(self, path: str, raw: bytes, flags="\\Seen") -> int:
        typ, data = self.c.append(q(path), f"({flags})" if flags else None, None, raw)
        self._ok(typ, data, "APPEND")
        m = re.search(rb"APPENDUID \d+ (\d+)", b" ".join(x for x in data if isinstance(x, bytes)))
        return int(m.group(1)) if m else 0

    def create(self, path):
        typ, data = self.c.create(q(path))
        self._ok(typ, data, "CREATE")
        self.c.subscribe(q(path))

    def delete(self, path):
        typ, data = self.c.delete(q(path))
        self._ok(typ, data, "DELETE")

    def rename(self, old, new):
        typ, data = self.c.rename(q(old), q(new))
        self._ok(typ, data, "RENAME")


def _seq(uids) -> str:
    uids = sorted(set(int(u) for u in uids))
    parts, start, prev = [], None, None
    for u in uids:
        if start is None:
            start = prev = u
        elif u == prev + 1:
            prev = u
        else:
            parts.append(f"{start}:{prev}" if prev != start else str(start))
            start = prev = u
    if start is not None:
        parts.append(f"{start}:{prev}" if prev != start else str(start))
    return ",".join(parts)


def _expand(s: bytes) -> list:
    out = []
    for p in s.decode().split(","):
        a, _, b = p.partition(":")
        out.extend(range(int(a), int(b) + 1) if b else [int(a)])
    return out


def _copyuid(resp, data) -> dict:
    txt = b" ".join(x for x in (resp or []) + (data or []) if isinstance(x, bytes))
    m = re.search(rb"(\d+) ([\d:,]+) ([\d:,]+)", txt)
    if not m:
        return {}
    src, dst = _expand(m.group(2)), _expand(m.group(3))
    return dict(zip(src, dst)) if len(src) == len(dst) else {}


def _clean(e) -> str:
    s = e if isinstance(e, str) else (b" ".join(x for x in e if isinstance(x, bytes)).decode("utf-8", "replace") if isinstance(e, list) else str(e))
    return s.replace("b'", "").replace("'", "").strip()[:300]


ROLE_NAMES = {
    "inbox": ("inbox",),
    "sent": ("sent", "sent items", "sent messages", "inviata", "posta inviata", "elementi inviati", "inviati", "[gmail]/sent mail", "[gmail]/posta inviata"),
    "drafts": ("drafts", "draft", "bozze"),
    "trash": ("trash", "deleted", "deleted items", "deleted messages", "cestino", "posta eliminata", "elementi eliminati"),
    "junk": ("junk", "spam", "junk e-mail", "posta indesiderata", "indesiderata"),
    "archive": ("archive", "archivio", "archives"),
}


def role_of(path: str, flags=()) -> str:
    fl = set(flags)
    for flag, role in (("\\sent", "sent"), ("\\drafts", "drafts"), ("\\trash", "trash"), ("\\junk", "junk"),
                       ("\\archive", "archive"), ("\\all", "all"), ("\\flagged", "flaggedall"), ("\\important", "important")):
        if flag in fl:
            return role
    p = path.lower()
    last = re.split(r"[./\\]", p)[-1]
    if p == "inbox":
        return "inbox"
    for role, names in ROLE_NAMES.items():
        if p in names or last in names or p.replace("inbox.", "").replace("inbox/", "") in names:
            return role
    return ""
