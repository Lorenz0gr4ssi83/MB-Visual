"""Motore della posta: indice locale, sincronizzazione in background, operazioni in coda (funzionano anche senza
rete e partono al ritorno della connessione), invio con posta in uscita e invio programmato, regole, PEC.

Un thread per account (connessione IMAP riusata) + un pianificatore. L'interfaccia interroga `status` ogni pochi
secondi: `ver` cambia a ogni modifica dell'indice, cosi' elenchi e cartelle si ricaricano solo quando serve.
"""
import json
import queue
import re
import threading
import time
import traceback
import uuid

from . import accounts, parse, store
from .imapc import Imap, MailError, flags_of
from ..i18n import t

RECEIPTS = ("accettazione", "non-accettazione", "presa-in-carico", "avvenuta-consegna", "errore-consegna",
            "preavviso-errore-consegna", "rilevazione-virus")
BIG = 25 * 1024 * 1024   # messaggi piu' grandi: corpo scaricato solo all'apertura
S = None
_VER = [0]
_STATUS: dict = {}
_NEW: list = []          # messaggi nuovi da segnalare (notifiche)
_WORKERS: dict = {}
_LOCK = threading.RLock()
_STARTED = [False]


def db():
    global S
    if S is None:
        S = store.get()
    return S


def bump():
    _VER[0] += 1


def ver():
    return _VER[0]


def set_status(aid, **kw):
    """Stato dell'account (sincronizzazione, errori): non cambia `ver`, che segnala solo modifiche ai messaggi."""
    st = _STATUS.setdefault(aid, {"stato": "pronto", "errore": "", "ultimo": 0, "avanzamento": ""})
    st.update(kw)


# ------------------------------------------------------------------ cartelle
def ensure_folder(aid, path, name=None, role="", delim="/", noselect=0, remote_id="") -> int:
    r = db().one("SELECT id, role, name FROM folders WHERE account=? AND path=?", (aid, path))
    if r:
        if (role and r["role"] != role) or (name and r["name"] != name):
            db().x("UPDATE folders SET role=?, name=?, delim=?, noselect=? WHERE id=?", (role or r["role"], name or r["name"], delim, noselect, r["id"]))
        return r["id"]
    return db().x("INSERT INTO folders(account, path, name, role, delim, noselect, remote_id) VALUES(?,?,?,?,?,?,?)",
                  (aid, path, name or path, role, delim, noselect, remote_id))


def folder_by_role(aid, role):
    return db().one("SELECT * FROM folders WHERE account=? AND role=? ORDER BY id LIMIT 1", (aid, role))


def local_folder(aid, role) -> dict:
    """Cartella locale (es. Inviata per gli account senza cartella sul server)."""
    f = folder_by_role(aid, role)
    if f:
        return f
    fid = ensure_folder(aid, {"sent": "Inviata", "drafts": "Bozze", "trash": "Cestino"}.get(role, role), role=role)
    return db().one("SELECT * FROM folders WHERE id=?", (fid,))


# ------------------------------------------------------------------ indice dei messaggi
def _thread(aid, s) -> str:
    ids = (s.get("refs") or "").split() + ([s["in_reply_to"]] if s.get("in_reply_to") else [])
    for mid in reversed(ids):
        r = db().one("SELECT thread FROM messages WHERE account=? AND msgid=? AND thread!='' LIMIT 1", (aid, mid))
        if r:
            return r["thread"]
    ref = s.get("pec_ref") or s.get("orig_msgid")
    if ref:
        r = db().one("SELECT thread FROM messages WHERE account=? AND msgid=? AND thread!='' LIMIT 1", (aid, ref))
        if r:
            return r["thread"]
    if s.get("msgid"):
        r = db().one("SELECT thread FROM messages WHERE account=? AND (in_reply_to=? OR pec_ref=?) AND thread!='' LIMIT 1",
                     (aid, s["msgid"], s["msgid"]))
        if r:
            return r["thread"]
    ns = s.get("nsubj") or ""
    if len(ns) > 3:
        r = db().one("SELECT thread FROM messages WHERE account=? AND nsubj=? AND date BETWEEN ? AND ? AND thread!='' ORDER BY date DESC LIMIT 1",
                     (aid, ns, (s.get("date") or 0) - 60 * 86400, (s.get("date") or time.time()) + 60 * 86400))
        if r:
            return r["thread"]
    return s.get("msgid") or uuid.uuid4().hex


def _people(s) -> str:
    out = [s.get("from_name", ""), s.get("from_addr", "")]
    for x in (s.get("to") or []) + (s.get("cc") or []):
        out += [x.get("n", ""), x.get("a", "")]
    return " ".join(o for o in out if o)


def _fts(mid, s):
    db().x("DELETE FROM fts WHERE rowid=?", (mid,))
    db().x("INSERT INTO fts(rowid, subject, people, body, atts) VALUES(?,?,?,?,?)",
           (mid, s.get("subject", ""), _people(s), s.get("body", ""), " ".join(a["nome"] for a in s.get("atts") or [])))


def add_message(aid, fid, raw: bytes, *, uid=0, remote_id="", flags=(), full=True, size=0, local=False) -> int:
    s = parse.summarize(raw, header_only=not full)
    s["nsubj"] = parse.norm_subject(s["subject"])
    fl = {f.lower().lstrip("\\") for f in flags}
    blob = db().put_raw(raw) if full else ""
    # messaggio spostato da qui (in attesa del suo nuovo UID): si aggancia la riga esistente con i dati locali
    if s["msgid"] and (uid or remote_id):
        r = db().one("SELECT id FROM messages WHERE folder_id=? AND msgid=? AND uid<=0 AND remote_id='' LIMIT 1", (fid, s["msgid"]))
        if r:
            db().x("UPDATE messages SET uid=?, remote_id=?, blob=CASE WHEN blob='' THEN ? ELSE blob END WHERE id=?", (uid, remote_id, blob, r["id"]))
            return r["id"]
    thread = _thread(aid, s)
    mid = db().x("""INSERT INTO messages(account, folder_id, uid, remote_id, msgid, in_reply_to, refs, thread, subject, from_name, from_addr,
        to_json, cc_json, date, size, seen, flagged, answered, forwarded, draft, has_att, att_json, preview, blob, pec, pec_ref, pec_json,
        invite, priority, added, nsubj) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                 (aid, fid, uid, remote_id, s["msgid"], s["in_reply_to"], s["refs"], thread, s["subject"], s["from_name"], s["from_addr"],
                  json.dumps(s["to"]), json.dumps(s["cc"]), s["date"] or time.time(), size or len(raw),
                  int("seen" in fl or local), int("flagged" in fl), int("answered" in fl), int("$forwarded" in fl), int("draft" in fl),
                  s["has_att"], json.dumps(s["atts"]), s["preview"], blob, s["pec"], s["pec_ref"], s["pec_json"], s["invite"],
                  s["priority"], time.time(), s["nsubj"]))
    _fts(mid, s)
    _pec_after_add(aid, fid, mid, s)
    bump()
    return mid


def fill_body(mid, raw: bytes):
    """Corpo completo arrivato dopo le sole intestazioni: aggiorna anteprima, allegati, ricerca e PEC."""
    row = db().one("SELECT * FROM messages WHERE id=?", (mid,))
    if not row:
        return
    s = parse.summarize(raw)
    blob = db().put_raw(raw)
    db().x("""UPDATE messages SET blob=?, has_att=?, att_json=?, preview=?, pec=?, pec_ref=?, pec_json=?, invite=?, subject=?,
              from_name=?, from_addr=? WHERE id=?""",
           (blob, s["has_att"], json.dumps(s["atts"]), s["preview"], s["pec"] or row["pec"], s["pec_ref"] or row["pec_ref"],
            s["pec_json"], s["invite"], s["subject"], s["from_name"], s["from_addr"], mid))
    _fts(mid, s)
    if s["pec"] in RECEIPTS and s["pec_ref"]:
        update_pec_state(row["account"], s["pec_ref"])
    bump()


def remove_message(mid):
    r = db().one("SELECT blob FROM messages WHERE id=?", (mid,))
    db().x("DELETE FROM messages WHERE id=?", (mid,))
    db().x("DELETE FROM fts WHERE rowid=?", (mid,))
    if r:
        db().drop_raw(r["blob"])
    bump()


def raw_of(mid) -> bytes:
    """Messaggio completo: dall'archivio cifrato o, se non ancora scaricato, dal server."""
    row = db().one("SELECT * FROM messages WHERE id=?", (mid,))
    if not row:
        raise MailError(t("srv_mail.messaggio_non_trovato"))
    raw = db().get_raw(row["blob"])
    if raw is not None:
        return raw
    acc = accounts.get(row["account"])
    prov = provider(acc)
    raw = prov.fetch_raw(row)
    if raw is None:
        raise MailError(t("srv_mail.messaggio_non_disponibile"))
    fill_body(mid, raw)
    return raw


# ------------------------------------------------------------------ PEC: ricevute collegate al messaggio inviato
def _pec_after_add(aid, fid, mid, s):
    acc = _acc(aid)
    f = db().one("SELECT role FROM folders WHERE id=?", (fid,))
    if s["pec"] in RECEIPTS and s["pec_ref"]:
        update_pec_state(aid, s["pec_ref"])
    elif acc and acc.get("pec") and f and f["role"] == "sent" and s["msgid"]:
        update_pec_state(aid, s["msgid"])


def _acc(aid):
    try:
        return accounts.get(aid)
    except KeyError:
        return None


def pec_status(aid, msgid) -> dict:
    """Stato PEC di un messaggio inviato dalle ricevute arrivate: accettazione, consegne per destinatario, errori."""
    recs = db().q("SELECT id, pec, pec_json, date, folder_id FROM messages WHERE account=? AND pec_ref=? AND pec!='' ORDER BY date",
                  (aid, msgid))
    st = {"accettazione": None, "non_accettazione": None, "consegne": {}, "errori": {}, "preavvisi": {}, "ricevute": []}
    expected = []
    for r in recs:
        dc = json.loads(r["pec_json"]) if r["pec_json"] else {}
        item = {"id": r["id"], "tipo": r["pec"], "data": dc.get("data") or parse.fmt_date(r["date"]), "ts": r["date"],
                "consegna": dc.get("consegna", ""), "gestore": dc.get("gestore", ""), "identificativo": dc.get("id", ""),
                "errore": dc.get("errore", ""), "errore_esteso": dc.get("errore_esteso", "")}
        st["ricevute"].append(item)
        if r["pec"] == "accettazione":
            st["accettazione"] = item
            expected = [d["a"] for d in dc.get("destinatari", []) if d.get("tipo") == "certificato"]
            st["esterni"] = [d["a"] for d in dc.get("destinatari", []) if d.get("tipo") != "certificato"]
        elif r["pec"] == "non-accettazione":
            st["non_accettazione"] = item
        elif r["pec"] == "avvenuta-consegna":
            st["consegne"][item["consegna"] or str(r["id"])] = item
        elif r["pec"] in ("errore-consegna", "rilevazione-virus"):
            st["errori"][item["consegna"] or str(r["id"])] = item
        elif r["pec"] == "preavviso-errore-consegna":
            st["preavvisi"][item["consegna"] or str(r["id"])] = item
    dest = []
    for a in expected or sorted(set(st["consegne"]) | set(st["errori"]) | set(st["preavvisi"])):
        stato = "consegnata" if a in st["consegne"] else "errore" if a in st["errori"] else "preavviso" if a in st["preavvisi"] else "attesa"
        dest.append({"a": a, "stato": stato, "ricevuta": (st["consegne"].get(a) or st["errori"].get(a) or st["preavvisi"].get(a) or {}).get("id")})
    st["destinatari"] = dest
    if st["non_accettazione"]:
        state = "non-accettata"
    elif not st["accettazione"] and not dest:
        state = "inviata"
    elif dest and all(d["stato"] == "consegnata" for d in dest):
        state = "consegnata"
    elif any(d["stato"] in ("errore", "preavviso") for d in dest):
        state = "errore" if not any(d["stato"] == "consegnata" for d in dest) else "parziale-errore"
    elif any(d["stato"] == "consegnata" for d in dest):
        state = "parziale"
    else:
        state = "accettata"
    st["stato"] = state
    for k in ("consegne", "errori", "preavvisi"):
        st[k] = list(st[k].values())
    return st


def update_pec_state(aid, msgid):
    sent = db().q("SELECT m.id FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.account=? AND m.msgid=? AND (f.role='sent' OR m.pec_state!='')",
                  (aid, msgid))
    if not sent:
        return
    st = pec_status(aid, msgid)["stato"]
    for r in sent:
        db().x("UPDATE messages SET pec_state=? WHERE id=?", (st, r["id"]))
    bump()


# ------------------------------------------------------------------ fornitori (IMAP; Microsoft Graph in graphmail.py)
def provider(acc):
    if acc.get("tipo") == "graph":
        from .graphmail import GraphProvider
        return GraphProvider(acc)
    return ImapProvider(acc)


def token_fn(acc):
    if acc.get("oauth"):
        from . import oauth
        return lambda: oauth.access_token(acc)
    return None


class ImapProvider:
    def __init__(self, acc):
        self.acc = acc
        self.conn = None

    def connect(self):
        if self.conn is not None:
            try:
                self.conn.c.noop()
                return self.conn
            except Exception:  # noqa: BLE001
                self.close()
        self.conn = Imap(self.acc, token_fn(self.acc))
        return self.conn

    def close(self):
        if self.conn:
            self.conn.close()
            self.conn = None

    # ---------------------------------------------------------- sincronizzazione
    def sync(self, progress=None, only=None):
        aid = self.acc["id"]
        c = self.connect()
        remote = c.folders()
        seen_paths = set()
        for f in remote:
            noselect = int("\\noselect" in f["flags"] or "\\nonexistent" in f["flags"])
            ensure_folder(aid, f["path"], f["name"], f["role"], f["delim"], noselect)
            seen_paths.add(f["path"])
        for f in db().q("SELECT id, path FROM folders WHERE account=? AND remote_id='' AND path NOT IN (%s)" % ",".join("?" * len(seen_paths)),
                        (aid, *seen_paths)) if seen_paths else []:
            if not db().one("SELECT 1 FROM messages WHERE folder_id=? AND uid<=0 LIMIT 1", (f["id"],)):
                for m in db().q("SELECT id FROM messages WHERE folder_id=?", (f["id"],)):
                    remove_message(m["id"])
                db().x("DELETE FROM folders WHERE id=?", (f["id"],))
        folders = db().q("SELECT * FROM folders WHERE account=? AND noselect=0 ORDER BY CASE role WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END, path", (aid,))
        folders = [f for f in folders if f["role"] not in ("all", "flaggedall", "important") and f["path"] in seen_paths]
        if only:
            folders = [f for f in folders if f["id"] in only]
        for i, f in enumerate(folders):
            if progress:
                progress(f"{f['name']} ({i + 1}/{len(folders)})")
            try:
                self.sync_folder(f)
            except MailError:
                raise
            except Exception as e:  # noqa: BLE001 - una cartella problematica non ferma le altre
                traceback.print_exc()
                set_status(aid, avviso=f"{f['name']}: {e}")
        # corpi completi per la lettura senza rete (dal piu' recente)
        for f in folders:
            self.fetch_bodies(f)

    def sync_folder(self, f):
        aid, c = self.acc["id"], self.conn
        info = c.select(f["path"])
        first = not f["synced"]
        if f["uidvalidity"] and info["uidvalidity"] and info["uidvalidity"] != f["uidvalidity"]:
            for m in db().q("SELECT id FROM messages WHERE folder_id=? AND uid>0", (f["id"],)):
                remove_message(m["id"])
        server = c.uids() if info["exists"] else []
        sset = set(server)
        local = {r["uid"]: r for r in db().q("SELECT id, uid, seen, flagged, answered, forwarded FROM messages WHERE folder_id=? AND uid>0", (f["id"],))}
        for uid, r in local.items():
            if uid not in sset:
                remove_message(r["id"])
        # stati dei messaggi gia' presenti
        known = sorted(u for u in local if u in sset)
        if known:
            for d in c.fetch(known, "UID FLAGS"):
                uid = int(d.get(b"UID", 0))
                r = local.get(uid)
                if not r:
                    continue
                fl = flags_of(d.get(b"FLAGS"))
                vals = (int("\\seen" in fl), int("\\flagged" in fl), int("\\answered" in fl), int("$forwarded" in fl))
                if vals != (r["seen"], r["flagged"], r["answered"], r["forwarded"]) and not _pending_flag(aid, r["id"]):
                    db().x("UPDATE messages SET seen=?, flagged=?, answered=?, forwarded=? WHERE id=?", (*vals, r["id"]))
                    bump()
        new = sorted((u for u in server if u not in local), reverse=True)
        added_inbox = []
        for i in range(0, len(new), 200):
            chunk = new[i:i + 200]
            for d in c.fetch(chunk, "UID FLAGS RFC822.SIZE BODY.PEEK[HEADER]"):
                uid = int(d.get(b"UID", 0))
                hdr = d.get(b"BODY[HEADER]")
                if not uid or not isinstance(hdr, bytes):
                    continue
                mid = add_message(aid, f["id"], hdr, uid=uid, flags=flags_of(d.get(b"FLAGS")), full=False, size=int(d.get(b"RFC822.SIZE", 0) or 0))
                if f["role"] == "inbox" and not first:
                    added_inbox.append(mid)
            set_status(aid, avanzamento=f"{f['name']}: {min(i + 200, len(new))}/{len(new)}")
        db().x("UPDATE folders SET uidvalidity=?, uidnext=?, synced=? WHERE id=?", (info["uidvalidity"], info["uidnext"], time.time(), f["id"]))
        if added_inbox:
            self.fetch_bodies(f, ids=added_inbox)
            from . import rules
            rules.apply_new(self.acc, added_inbox)
            for mid in added_inbox:
                r = db().one("SELECT id, subject, from_name, from_addr, seen, pec FROM messages WHERE id=?", (mid,))
                if r and not r["seen"] and r["pec"] not in RECEIPTS:
                    _NEW.append({**r, "account": aid})
            del _NEW[:-50]

    def fetch_bodies(self, f, ids=None):
        days = int(self.acc.get("scarica_giorni") or 0)
        since = time.time() - days * 86400 if days > 0 else 0
        if ids:
            rows = db().q("SELECT id, uid FROM messages WHERE id IN (%s) AND blob='' AND uid>0" % ",".join("?" * len(ids)), ids)
        else:
            rows = db().q("SELECT id, uid FROM messages WHERE folder_id=? AND blob='' AND uid>0 AND size<? AND date>=? ORDER BY date DESC",
                          (f["id"], BIG, since))
        if not rows:
            return
        c = self.conn
        c.select(f["path"])
        by_uid = {r["uid"]: r["id"] for r in rows}
        uids, batch, tot = list(by_uid), [], 0
        done = 0
        for u in uids:
            batch.append(u)
            if len(batch) >= 25:
                done += self._bodies(c, batch, by_uid)
                batch = []
                set_status(self.acc["id"], avanzamento=t("srv_mail.scaricati_n", f["name"], done, len(uids)))
        if batch:
            self._bodies(c, batch, by_uid)
        set_status(self.acc["id"], avanzamento="")

    def _bodies(self, c, batch, by_uid):
        n = 0
        for d in c.fetch(batch, "UID BODY.PEEK[]"):
            uid = int(d.get(b"UID", 0))
            raw = d.get(b"BODY[]")
            if uid in by_uid and isinstance(raw, bytes):
                fill_body(by_uid[uid], raw)
                n += 1
        return n

    def fetch_raw(self, row):
        f = db().one("SELECT * FROM folders WHERE id=?", (row["folder_id"],))
        if not f or row["uid"] <= 0:
            return None
        with Imap(self.acc, token_fn(self.acc)) as c:
            c.select(f["path"], readonly=True)
            for d in c.fetch([row["uid"]], "UID BODY.PEEK[]"):
                if isinstance(d.get(b"BODY[]"), bytes):
                    return d[b"BODY[]"]
        return None

    # ---------------------------------------------------------- operazioni
    def apply(self, op, args):
        c = self.connect()
        if op == "flags":
            for path, uids in _by_folder(args["ids"]):
                c.select(path)
                for k, flag in (("seen", "\\Seen"), ("flagged", "\\Flagged"), ("answered", "\\Answered"), ("forwarded", "$Forwarded")):
                    if k in args:
                        c.store(uids, "+FLAGS.SILENT" if args[k] else "-FLAGS.SILENT", flag)
        elif op == "move":
            dest = db().one("SELECT * FROM folders WHERE id=?", (args["dest"],))
            for path, uids in _by_folder_src(args["src"], args["uids"]):
                c.select(path)
                mapping = c.move(uids, dest["path"])
                for old, new in mapping.items():
                    mid = args.get("ids_by_uid", {}).get(str(old))
                    if mid:
                        db().x("UPDATE messages SET uid=? WHERE id=? AND folder_id=? AND uid<=0", (new, mid, dest["id"]))
        elif op == "expunge":
            for path, uids in _by_folder_src(args["src"], args["uids"]):
                c.select(path)
                c.store(uids, "+FLAGS.SILENT", "\\Deleted")
                c.expunge(uids)
        elif op == "append":
            f = db().one("SELECT * FROM folders WHERE id=?", (args["folder"],))
            raw = db().get_raw(args["blob"])
            if f and raw:
                if args.get("replace_uid"):
                    c.select(f["path"])
                    c.store([args["replace_uid"]], "+FLAGS.SILENT", "\\Deleted")
                    c.expunge([args["replace_uid"]])
                uid = c.append(f["path"], raw, args.get("flags", "\\Seen"))
                if uid and args.get("mid"):
                    db().x("UPDATE messages SET uid=? WHERE id=?", (uid, args["mid"]))
        elif op == "folder_create":
            c.create(args["path"])
        elif op == "folder_delete":
            c.delete(args["path"])
        elif op == "folder_rename":
            c.rename(args["old"], args["new"])

    def send(self, raw, sender, rcpt):
        from . import compose
        return compose.send(self.acc, raw, sender, rcpt, token_fn(self.acc))


def _pending_flag(aid, mid) -> bool:
    for o in db().q("SELECT args FROM ops WHERE account=? AND kind='flags'", (aid,)):
        if mid in json.loads(o["args"]).get("ids", []):
            return True
    return False


def _by_folder(ids):
    rows = db().q("SELECT m.uid, f.path FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.id IN (%s) AND m.uid>0" % ",".join("?" * len(ids)), ids)
    out = {}
    for r in rows:
        out.setdefault(r["path"], []).append(r["uid"])
    return out.items()


def _by_folder_src(src, uids):
    f = db().one("SELECT path FROM folders WHERE id=?", (src,))
    return [(f["path"], uids)] if f and uids else []


# ------------------------------------------------------------------ operazioni locali + coda verso il server
def enqueue(aid, kind, args):
    db().x("INSERT INTO ops(account, kind, args) VALUES(?,?,?)", (aid, kind, json.dumps(args)))
    kick(aid)


def set_flags(ids, **vals):
    """seen / flagged / answered / forwarded (anche sul server) e campi locali (categorie, scadenze, promemoria, commessa)."""
    if not ids:
        return
    ph = ",".join("?" * len(ids))
    server = {k: v for k, v in vals.items() if k in ("seen", "flagged", "answered", "forwarded")}
    local = {k: v for k, v in vals.items() if k in ("categories", "flag_due", "flag_done", "remind_at", "commessa")}
    for k, v in {**server, **local}.items():
        if k == "categories" and not isinstance(v, str):
            v = json.dumps(v)
        elif k in server:
            v = int(bool(v))
        db().x(f"UPDATE messages SET {k}=? WHERE id IN ({ph})", (v, *ids))
    if "flagged" in vals and not vals["flagged"]:
        db().x(f"UPDATE messages SET flag_due=0 WHERE id IN ({ph})", ids)
    if server:
        for aid, mids in _by_account(ids).items():
            enqueue(aid, "flags", {"ids": mids, **server})
    if "categories" in local or "flag_done" in local:  # Microsoft Graph conserva anche categorie e completamento
        for aid, mids in _by_account(ids).items():
            a = _acc(aid)
            if a and a.get("tipo") == "graph":
                enqueue(aid, "local", {"ids": mids})
    bump()


def _by_account(ids):
    out = {}
    for r in db().q("SELECT id, account FROM messages WHERE id IN (%s)" % ",".join("?" * len(ids)), ids):
        out.setdefault(r["account"], []).append(r["id"])
    return out


def move(ids, dest_id):
    dest = db().one("SELECT * FROM folders WHERE id=?", (dest_id,))
    if not dest:
        raise MailError(t("srv_mail.cartella_inesistente"))
    rows = db().q("SELECT id, account, folder_id, uid, remote_id FROM messages WHERE id IN (%s)" % ",".join("?" * len(ids)), ids)
    groups = {}
    for r in rows:
        if r["folder_id"] == dest_id:
            continue
        if r["account"] != dest["account"]:
            _copy_cross(r, dest)
            continue
        groups.setdefault(r["folder_id"], []).append(r)
    for src, rs in groups.items():
        uids = [r["uid"] for r in rs if r["uid"] > 0]
        rids = [r["remote_id"] for r in rs if r["remote_id"]]
        db().x("UPDATE messages SET folder_id=?, uid=0 WHERE id IN (%s)" % ",".join("?" * len(rs)), (dest_id, *[r["id"] for r in rs]))
        if uids or rids:
            enqueue(dest["account"], "move", {"src": src, "dest": dest_id, "uids": uids, "remote_ids": rids,
                                              "ids_by_uid": {str(r["uid"]): r["id"] for r in rs}, "ids": [r["id"] for r in rs]})
    bump()


def _copy_cross(r, dest):
    """Spostamento tra account diversi: copia nel nuovo account (APPEND) ed eliminazione dall'originale."""
    raw = raw_of(r["id"])
    mid = add_message(dest["account"], dest["id"], raw, local=True)
    blob = db().one("SELECT blob FROM messages WHERE id=?", (mid,))["blob"]
    enqueue(dest["account"], "append", {"folder": dest["id"], "blob": blob, "mid": mid})
    delete([r["id"]], permanent=True)


def delete(ids, permanent=False):
    rows = db().q("SELECT m.id, m.account, m.folder_id, m.uid, m.remote_id, f.role FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.id IN (%s)"
                  % ",".join("?" * len(ids)), ids)
    to_trash = {}
    for r in rows:
        if permanent or r["role"] == "trash":
            if r["uid"] > 0 or r["remote_id"]:
                enqueue(r["account"], "expunge", {"src": r["folder_id"], "uids": [r["uid"]] if r["uid"] > 0 else [],
                                                  "remote_ids": [r["remote_id"]] if r["remote_id"] else []})
            remove_message(r["id"])
        else:
            to_trash.setdefault(r["account"], []).append(r["id"])
    for aid, mids in to_trash.items():
        tr = folder_by_role(aid, "trash")
        if tr:
            move(mids, tr["id"])
        else:
            delete(mids, permanent=True)
    bump()


# ------------------------------------------------------------------ invio (posta in uscita)
def queue_send(aid, raw, info, send_at=None, draft_id=0):
    blob = db().put_raw(raw)
    oid = db().x("INSERT INTO outbox(account, send_at, created, blob, subject, rcpt, draft_id, info) VALUES(?,?,?,?,?,?,?,?)",
                 (aid, send_at or 0, time.time(), blob, parse.summarize(raw, header_only=True)["subject"], json.dumps(info["rcpt"]),
                  draft_id, json.dumps(info)))
    if not send_at:
        kick(aid)
    bump()
    return oid


def _send_due(aid, prov):
    now = time.time()
    sent_n = 0
    for o in db().q("SELECT * FROM outbox WHERE account=? AND status IN ('attesa','errore') AND send_at<=? ORDER BY id", (aid, now)):
        if o["status"] == "errore" and json.loads(o["info"]).get("tentativi", 0) >= 5:
            continue
        raw = db().get_raw(o["blob"])
        info = json.loads(o["info"])
        db().x("UPDATE outbox SET status='invio' WHERE id=?", (o["id"],))
        bump()
        try:
            prov.send(raw, info["from"], info["rcpt"])
        except MailError as e:
            info["tentativi"] = info.get("tentativi", 0) + 1
            db().x("UPDATE outbox SET status=?, error=?, info=? WHERE id=?",
                   ("attesa" if e.offline else "errore", str(e), json.dumps(info), o["id"]))
            bump()
            if e.offline:
                raise
            continue
        # copia in Inviata (Gmail e Microsoft la salvano da soli)
        acc = prov.acc
        sent = folder_by_role(aid, "sent") or local_folder(aid, "sent")
        if acc.get("tipo") != "graph":
            mid = add_message(aid, sent["id"], raw, local=True)
            if acc.get("salva_inviati", True) and sent.get("path") and folder_by_role(aid, "sent"):
                enqueue(aid, "append", {"folder": sent["id"], "blob": o["blob"], "mid": mid})
        if info.get("reply_to_id"):
            set_flags([info["reply_to_id"]], **({"forwarded": 1} if info.get("forward") else {"answered": 1}))
        if o["draft_id"]:
            delete([o["draft_id"]], permanent=True)
        db().x("DELETE FROM outbox WHERE id=?", (o["id"],))
        sent_n += 1
        bump()
    return sent_n


# ------------------------------------------------------------------ thread per account e pianificatore
class Worker(threading.Thread):
    def __init__(self, aid):
        super().__init__(daemon=True)
        self.aid = aid
        self.q = queue.Queue()
        self.prov = None
        self.last_sync = 0

    def run(self):
        while True:
            try:
                what = self.q.get(timeout=20)
            except queue.Empty:
                what = "tick"
            if self.step(what) == "stop":
                return

    def step(self, what):
        try:
            acc = accounts.get(self.aid)
        except KeyError:
            return "stop"
        if not acc.get("attivo", True):
            return None
        if self.prov is None or self.prov.acc != acc:
            if self.prov and hasattr(self.prov, "close"):
                self.prov.close()
            self.prov = provider(acc)
        interval = max(1, int(acc.get("intervallo") or 3)) * 60
        due = what in ("sync", "full") or time.time() - self.last_sync >= interval
        try:
            self._flush_ops()
            if _send_due(self.aid, self.prov):
                self._flush_ops()  # copie in Inviata appena spedite
            if due:
                set_status(self.aid, stato="sync", errore="")
                self.prov.sync(progress=lambda m: set_status(self.aid, avanzamento=m))
                self.last_sync = time.time()
                self._flush_ops()
                set_status(self.aid, stato="ok", ultimo=time.time(), avanzamento="", errore="", auth=False)
                from . import calsync
                calsync.sync_account(acc)
        except MailError as e:
            if hasattr(self.prov, "close"):
                self.prov.close()
            self.last_sync = time.time()
            set_status(self.aid, stato="offline" if e.offline else "errore", errore=str(e), auth=e.auth, avanzamento="")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            if hasattr(self.prov, "close"):
                self.prov.close()
            self.last_sync = time.time()
            set_status(self.aid, stato="errore", errore=str(e) or e.__class__.__name__, avanzamento="")
        return None

    def _flush_ops(self):
        ops = db().q("SELECT * FROM ops WHERE account=? ORDER BY id", (self.aid,))
        if not ops:
            return
        for o in ops:
            try:
                self.prov.apply(o["kind"], json.loads(o["args"]))
                db().x("DELETE FROM ops WHERE id=?", (o["id"],))
            except MailError as e:
                if e.offline or e.auth:
                    raise
                db().x("UPDATE ops SET tries=tries+1, error=? WHERE id=?", (str(e), o["id"]))
                if o["tries"] >= 4:
                    db().x("DELETE FROM ops WHERE id=?", (o["id"],))
        bump()


def run_once(aid, what="sync"):
    """Un giro completo (operazioni, invii, sincronizzazione) nel thread chiamante: per le prove automatiche."""
    w = _WORKERS.get("_sync_" + aid) or Worker(aid)
    _WORKERS["_sync_" + aid] = w
    w.step(what)
    if w.prov and hasattr(w.prov, "close"):
        w.prov.close()
    return _STATUS.get(aid, {})


NO_THREADS = [False]


def kick(aid=None, what="ops"):
    if NO_THREADS[0]:
        return
    start()
    with _LOCK:
        for a in accounts.all_accounts():
            if aid and a["id"] != aid:
                continue
            w = _WORKERS.get(a["id"])
            if w is None or not w.is_alive():
                w = _WORKERS[a["id"]] = Worker(a["id"])
                w.start()
            w.q.put(what)


def start():
    if _STARTED[0] or NO_THREADS[0]:
        return
    _STARTED[0] = True
    db()
    threading.Thread(target=_scheduler, daemon=True).start()


def _scheduler():
    while True:
        try:
            with _LOCK:
                for a in accounts.all_accounts():
                    w = _WORKERS.get(a["id"])
                    if w is None or not w.is_alive():
                        w = _WORKERS[a["id"]] = Worker(a["id"])
                        w.start()
                        w.q.put("sync")
            due = db().q("SELECT DISTINCT account FROM outbox WHERE status='attesa' AND send_at>0 AND send_at<=?", (time.time(),))
            for r in due:
                if r["account"] in _WORKERS:
                    _WORKERS[r["account"]].q.put("ops")
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(15)


def status() -> dict:
    return {"ver": ver(), "account": {a["id"]: _STATUS.get(a["id"], {"stato": "pronto"}) for a in accounts.all_accounts()}}


def take_new():
    out = list(_NEW)
    _NEW.clear()
    return out


def reset_account(aid):
    """Account eliminato: via cartelle, messaggi e operazioni in coda."""
    for m in db().q("SELECT id FROM messages WHERE account=?", (aid,)):
        remove_message(m["id"])
    db().x("DELETE FROM folders WHERE account=?", (aid,))
    db().x("DELETE FROM ops WHERE account=?", (aid,))
    db().x("DELETE FROM outbox WHERE account=?", (aid,))
    _STATUS.pop(aid, None)
    _WORKERS.pop(aid, None)
    bump()


_word = re.compile(r"\w+", re.U)
