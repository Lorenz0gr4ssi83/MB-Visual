"""API della posta per l'interfaccia (ui/js/mail/*): un solo ingresso /api/mail?op=... (server.py `api_mail`)."""
import html as htmlmod
import json
import mimetypes
import re
import shutil
import time
import webbrowser
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from . import accounts, commesse, compose, engine, parse, rules
from .imapc import MailError
from .. import jobs
from ..i18n import t
from ..paths import TEMP_DIR

ATT_DIR = TEMP_DIR / "posta"
LIST_COLS = """m.id, m.account, m.folder_id, m.subject, m.from_name, m.from_addr, m.to_json, m.date, m.seen, m.flagged, m.answered,
  m.forwarded, m.draft, m.has_att, m.preview, m.categories, m.flag_due, m.flag_done, m.remind_at, m.commessa, m.pec, m.pec_state,
  m.priority, m.size, m.thread, m.invite, m.blob!='' AS scaricato"""
_CLEANED = [False]


def _cleanup():
    if _CLEANED[0]:
        return
    _CLEANED[0] = True
    if ATT_DIR.exists():  # allegati aperti nelle sessioni precedenti (in chiaro): via dopo un giorno
        for d in ATT_DIR.iterdir():
            try:
                if time.time() - d.stat().st_mtime > 86400:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass


# ------------------------------------------------------------------ ricerca
_OPS = {"da": "from", "from": "from", "a": "to", "to": "to", "per": "to", "oggetto": "subject", "subject": "subject",
        "ha": "has", "has": "has", "e": "is", "è": "is", "is": "is", "commessa": "commessa", "categoria": "cat",
        "category": "cat", "prima": "before", "before": "before", "dopo": "after", "after": "after", "pec": "pec",
        "allegato": "att", "attachment": "att"}


def _date_arg(v):
    for f in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y"):
        try:
            return datetime.strptime(v, f).timestamp()
        except ValueError:
            continue
    return None


def _fts_term(w):
    w = re.sub(r'["*]', " ", w).strip()
    return " ".join(f'"{x}"*' for x in w.split()) if w else ""


def parse_query(q: str):
    """Testo di ricerca -> (condizioni SQL, argomenti). Operatori: da: a: oggetto: ha:allegato e:nonletto e:contrassegnato
    commessa: categoria: prima: dopo: pec: allegato: (anche in inglese: from: to: subject: has:attachment is:unread...)."""
    conds, args, fts = [], [], []
    for m in re.finditer(r'(\w+|è):("([^"]*)"|\S+)|"([^"]*)"|(\S+)', q or "", re.U):
        if m.group(1):
            op = _OPS.get(m.group(1).lower())
            val = m.group(3) if m.group(3) is not None else m.group(2)
            if not op:
                fts.append(_fts_term(m.group(0)))
                continue
            v = val.lower()
            if op == "from":
                conds.append("(m.from_addr LIKE ? OR m.from_name LIKE ?)")
                args += [f"%{v}%", f"%{v}%"]
            elif op == "to":
                conds.append("(m.to_json LIKE ? OR m.cc_json LIKE ?)")
                args += [f"%{v}%", f"%{v}%"]
            elif op == "subject":
                fts.append("subject : (" + _fts_term(val) + ")")
            elif op == "att":
                fts.append("atts : (" + _fts_term(val) + ")")
            elif op == "has":
                if v in ("allegato", "allegati", "attachment", "attachments", "anhang", "pièce", "adjunto"):
                    conds.append("m.has_att=1")
                elif v in ("invito", "invite"):
                    conds.append("m.invite=1")
            elif op == "is":
                if v in ("nonletto", "nonletti", "unread", "ungelesen", "nonlu", "noleido"):
                    conds.append("m.seen=0")
                elif v in ("letto", "read"):
                    conds.append("m.seen=1")
                elif v in ("contrassegnato", "flagged", "bandiera"):
                    conds.append("m.flagged=1")
                elif v in ("risposto", "answered"):
                    conds.append("m.answered=1")
            elif op == "commessa":
                conds.append("m.commessa IN (SELECT id FROM commesse WHERE nome LIKE ? OR codice LIKE ? OR id=?)")
                args += [f"%{val}%", f"%{val}%", val]
            elif op == "cat":
                conds.append("m.categories LIKE ?")
                args.append(f'%"{val}%')
            elif op in ("before", "after"):
                d = _date_arg(val)
                if d:
                    conds.append("m.date < ?" if op == "before" else "m.date >= ?")
                    args.append(d if op == "before" else d)
            elif op == "pec":
                if v in ("ricevute", "receipts"):
                    conds.append("m.pec IN (%s)" % ",".join("?" * len(engine.RECEIPTS)))
                    args += list(engine.RECEIPTS)
                elif v in ("errore", "error", "errori"):
                    conds.append("m.pec_state IN ('errore','parziale-errore','non-accettata')")
                else:
                    conds.append("(m.pec!='' OR m.pec_state!='')")
        else:
            term = m.group(4) if m.group(4) is not None else m.group(5)
            if term:
                fts.append(_fts_term(term))
    fts = [f for f in fts if f]
    if fts:
        conds.append("m.id IN (SELECT rowid FROM fts WHERE fts MATCH ?)")
        args.append(" AND ".join(fts))
    return conds, args


# ------------------------------------------------------------------ elenchi
def _folder_conds(folder, b):
    db = engine.db()
    hide_rec = db.setting("nascondi_ricevute", True)
    conds, args = [], []
    if isinstance(folder, int) or (isinstance(folder, str) and folder.isdigit()):
        conds.append("m.folder_id=?")
        args.append(int(folder))
        if hide_rec:
            conds.append("m.pec NOT IN (%s)" % ",".join("?" * len(engine.RECEIPTS)))
            args += list(engine.RECEIPTS)
    elif folder == "unificata":
        conds.append("m.folder_id IN (SELECT id FROM folders WHERE role='inbox')")
        if hide_rec:
            conds.append("m.pec NOT IN (%s)" % ",".join("?" * len(engine.RECEIPTS)))
            args += list(engine.RECEIPTS)
    elif folder == "contrassegnati":
        conds.append("m.flagged=1 AND m.flag_done=0")
    elif folder == "promemoria":
        conds.append("m.remind_at>0")
    elif folder == "nonletti":
        conds.append("m.seen=0 AND m.folder_id NOT IN (SELECT id FROM folders WHERE role IN ('trash','junk','sent','drafts'))")
        if hide_rec:
            conds.append("m.pec NOT IN (%s)" % ",".join("?" * len(engine.RECEIPTS)))
            args += list(engine.RECEIPTS)
    elif folder == "pec":
        conds.append("m.pec_state!=''")
    elif folder == "ricevute":
        conds.append("m.pec IN (%s)" % ",".join("?" * len(engine.RECEIPTS)))
        args += list(engine.RECEIPTS)
    elif folder == "pec_ricevute":
        conds.append("m.pec='posta-certificata'")
    elif isinstance(folder, str) and folder.startswith("commessa:"):
        conds.append("m.commessa=?")
        args.append(folder[9:])
    elif folder == "tutto":
        conds.append("m.folder_id NOT IN (SELECT id FROM folders WHERE role IN ('trash','junk'))")
    if b.get("account") and not (isinstance(folder, int) or str(folder).isdigit()):
        conds.append("m.account=?")
        args.append(b["account"])
    f = b.get("filtro")
    if f == "nonletti":
        conds.append("m.seen=0")
    elif f == "contrassegnati":
        conds.append("m.flagged=1")
    elif f == "allegati":
        conds.append("m.has_att=1")
    elif f == "me":
        mine = [a["email"].lower() for a in accounts.all_accounts() if a.get("email")]
        if mine:
            conds.append("(" + " OR ".join("m.to_json LIKE ?" for _ in mine) + ")")
            args += [f"%{x}%" for x in mine]
    elif f == "pec":
        conds.append("(m.pec!='' OR m.pec_state!='')")
    elif f == "commessa":
        conds.append("m.commessa!=''")
    return conds, args


def _row(r):
    r["to"] = json.loads(r.pop("to_json") or "[]")[:3]
    r["categories"] = json.loads(r["categories"] or "[]")
    return r


def list_messages(b: dict) -> dict:
    db = engine.db()
    folder = b.get("folder", "unificata")
    conds, args = _folder_conds(folder, b)
    if b.get("q"):
        c2, a2 = parse_query(b["q"])
        conds += c2
        args += a2
    where = " AND ".join(conds) or "1"
    limit, offset = int(b.get("limit") or 200), int(b.get("offset") or 0)
    order = {"data": "date DESC", "data_asc": "date ASC", "mittente": "from_name COLLATE NOCASE, date DESC",
             "oggetto": "nsubj, date DESC", "dimensione": "size DESC"}.get(b.get("ordina"), "date DESC")
    if b.get("conversazioni") and order.startswith("date"):
        tot = db.one(f"SELECT COUNT(DISTINCT m.thread) n FROM messages m WHERE {where}", args)["n"]
        th = db.q(f"""SELECT m.thread, MAX(m.date) d, COUNT(*) n, SUM(1-m.seen) u, MAX(m.flagged) fl FROM messages m WHERE {where}
                    GROUP BY m.thread ORDER BY d {'DESC' if 'DESC' in order else 'ASC'} LIMIT ? OFFSET ?""", (*args, limit, offset))
        out = []
        for x in th:
            r = db.one(f"SELECT {LIST_COLS} FROM messages m WHERE {where} AND m.thread=? ORDER BY m.date DESC LIMIT 1", (*args, x["thread"]))
            if not r:
                continue
            r = _row(r)
            allc = db.one("""SELECT COUNT(*) n, COUNT(DISTINCT from_addr) p FROM messages m WHERE m.thread=? AND m.account=?
                             AND m.folder_id NOT IN (SELECT id FROM folders WHERE role IN ('trash','junk'))""", (x["thread"], r["account"]))
            r.update(conv_n=max(x["n"], allc["n"]), conv_unread=x["u"], conv_flag=x["fl"])
            out.append(r)
        return {"ok": True, "items": out, "totale": tot, "ver": engine.ver()}
    tot = db.one(f"SELECT COUNT(*) n FROM messages m WHERE {where}", args)["n"]
    rows = db.q(f"SELECT {LIST_COLS} FROM messages m WHERE {where} ORDER BY m.{order.replace(', ', ', m.')} LIMIT ? OFFSET ?", (*args, limit, offset))
    return {"ok": True, "items": [_row(r) for r in rows], "totale": tot, "ver": engine.ver()}


def thread_messages(b):
    db = engine.db()
    rows = db.q(f"""SELECT {LIST_COLS}, f.role AS folder_role, f.name AS folder_name FROM messages m JOIN folders f ON f.id=m.folder_id
                    WHERE m.thread=? AND m.account=? AND f.role NOT IN ('trash','junk') ORDER BY m.date""", (b["thread"], b["account"]))
    return {"ok": True, "items": [_row(r) for r in rows]}


def folders() -> dict:
    db = engine.db()
    accs = []
    counts = {r["folder_id"]: r for r in db.q(
        "SELECT folder_id, SUM(1-seen) u, COUNT(*) n FROM messages WHERE pec NOT IN (%s) GROUP BY folder_id" % ",".join("?" * len(engine.RECEIPTS)),
        engine.RECEIPTS)}
    for a in accounts.all_accounts():
        fs = db.q("SELECT id, path, name, role, delim, noselect FROM folders WHERE account=? ORDER BY path COLLATE NOCASE", (a["id"],))
        for f in fs:
            c = counts.get(f["id"]) or {}
            f["unread"], f["total"] = c.get("u") or 0, c.get("n") or 0
        outbox = db.one("SELECT COUNT(*) n FROM outbox WHERE account=?", (a["id"],))["n"]
        accs.append({**accounts.public(a), "cartelle": fs, "uscita": outbox})
    virt = {
        "unificata": db.one("SELECT COUNT(*) n FROM messages WHERE seen=0 AND pec NOT IN (%s) AND folder_id IN (SELECT id FROM folders WHERE role='inbox')"
                            % ",".join("?" * len(engine.RECEIPTS)), engine.RECEIPTS)["n"],
        "contrassegnati": db.one("SELECT COUNT(*) n FROM messages WHERE flagged=1 AND flag_done=0")["n"],
        "promemoria": db.one("SELECT COUNT(*) n FROM messages WHERE remind_at>0 AND remind_at<=?", (time.time(),))["n"],
        "pec": db.one("SELECT COUNT(*) n FROM messages WHERE pec_state IN ('errore','parziale-errore','non-accettata')")["n"],
        "uscita": db.one("SELECT COUNT(*) n FROM outbox")["n"],
    }
    return {"ok": True, "account": accs, "virtuali": virt, "commesse": commesse.all_(), "ver": engine.ver()}


# ------------------------------------------------------------------ lettura
def message(b) -> dict:
    db = engine.db()
    mid = int(b["id"])
    row = db.one("SELECT m.*, f.role AS folder_role, f.name AS folder_name FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.id=?", (mid,))
    if not row:
        raise MailError(t("srv_mail.messaggio_non_trovato"))
    raw = engine.raw_of(mid)
    out = parse.render(raw)
    out["m"] = _row({k: row[k] for k in row if k not in ("blob",)})
    out["m"]["cc"] = json.loads(row["cc_json"] or "[]")
    if row["pec_state"] and row["msgid"]:
        out["pec_stato"] = engine.pec_status(row["account"], row["msgid"])
    if row["pec"] in engine.RECEIPTS and row["pec_ref"]:
        orig = db.one("SELECT id, subject FROM messages WHERE account=? AND msgid=? AND pec_state!='' LIMIT 1", (row["account"], row["pec_ref"]))
        out["pec_originale"] = orig
    if not row["commessa"]:
        body = (db.one("SELECT body FROM fts WHERE rowid=?", (mid,)) or {}).get("body", "")
        out["commessa_suggerita"] = commesse.suggest(row, body)
    inv = []
    for i in out.get("inviti") or []:
        try:
            data, _, _ = parse.get_part(raw, str(i))
            inv.append({"i": i, "ics": data.decode("utf-8", "replace")})
        except Exception:  # noqa: BLE001
            pass
    out["inviti"] = inv
    out["mdn_inviata"] = bool(out["h"].get("notify")) and out["h"].get("msgid") in (engine.db().setting("mdn_inviati", []) or [])
    return out


def part(b):
    mid = int(b["id"])
    raw = engine.raw_of(mid)
    if b.get("cid"):
        data, ctype = parse.part_by_cid(raw, b["cid"])
        if data is None:
            raise MailError(t("srv_mail.parte_non_trovata"))
        return data, {"Content-Type": ctype or "application/octet-stream", "Cross-Origin-Resource-Policy": "cross-origin",
                      "Cache-Control": "max-age=3600"}
    data, ctype, name = parse.get_part(raw, str(b["i"]))
    if ctype.startswith("text/") and "charset" not in ctype:
        ctype += "; charset=utf-8"
    hdr = {"Content-Type": ctype if not b.get("download") else "application/octet-stream", "Cross-Origin-Resource-Policy": "cross-origin"}
    return data, hdr


def att_file(b) -> dict:
    """Allegato in un file temporaneo (per aprirlo in una scheda di MB Visual o con un altro programma)."""
    _cleanup()
    mid = int(b["id"])
    raw = engine.raw_of(mid)
    data, ctype, name = parse.get_part(raw, str(b["i"]))
    if not name:
        ext = mimetypes.guess_extension(ctype) or ".bin"
        name = f"allegato{ext}"
    d = ATT_DIR / f"{mid}-{str(b['i']).replace('.', '_')}"
    d.mkdir(parents=True, exist_ok=True)
    p = d / commesse.safe(name, 150)
    if not p.exists() or p.stat().st_size != len(data):
        p.write_bytes(data)
    return {"ok": True, "path": str(p), "nome": p.name}


def eml_file(b) -> dict:
    _cleanup()
    mid = int(b["id"])
    raw = engine.raw_of(mid)
    row = engine.db().one("SELECT subject FROM messages WHERE id=?", (mid,))
    d = ATT_DIR / f"{mid}-eml"
    d.mkdir(parents=True, exist_ok=True)
    p = d / (commesse.safe(row["subject"] or "messaggio", 80) + ".eml")
    p.write_bytes(raw)
    return {"ok": True, "path": str(p), "nome": p.name}


def save_atts(b) -> dict:
    dest = Path(b["dest"])
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for mid in b["ids"]:
        raw = engine.raw_of(int(mid))
        out += commesse.save_attachments(raw, dest, which=[str(x) for x in b["parti"]] if b.get("parti") else None)
    return {"ok": True, "file": out, "cartella": str(dest)}


def img_proxy(b):
    """Immagini remote dei messaggi HTML, solo quando l'utente le mostra: passano dal motore (niente richieste dirette
    dalla pagina, intestazioni neutre, solo immagini fino a 8 MB)."""
    url = b.get("url", "")
    if urlparse(url).scheme not in ("http", "https"):
        raise MailError("url")
    with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0 MBVisual"}), timeout=15) as r:  # noqa: S310
        ctype = r.headers.get("Content-Type", "")
        data = r.read(8 * 1024 * 1024 + 1)
    if not ctype.startswith("image/") or len(data) > 8 * 1024 * 1024:
        raise MailError("tipo")
    return data, {"Content-Type": ctype, "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "max-age=86400"}


# ------------------------------------------------------------------ composizione
def _prefix(subject, kind):
    p = t("mail.prefisso_risposta") if kind == "reply" else t("mail.prefisso_inoltro")
    s = parse._RE_PREFIX.sub("", subject or "").strip()
    return f"{p} {s}".strip()


def _quote_header(h, m):
    who = lambda lst: htmlmod.escape(", ".join(f"{x['n']} <{x['a']}>" if x.get("n") else x["a"] for x in lst))  # noqa: E731
    rows = [(t("mail.q_da"), who(h["from"])), (t("mail.q_inviato"), datetime.fromtimestamp(h["date"] or m["date"]).strftime("%d/%m/%Y %H:%M")),
            (t("mail.q_a"), who(h["to"]))]
    if h["cc"]:
        rows.append((t("mail.q_cc"), who(h["cc"])))
    rows.append((t("mail.q_oggetto"), htmlmod.escape(h["subject"])))
    return "".join(f"<b>{k}:</b> {v}<br>" for k, v in rows)


def _body_html(r):
    if r["html"]:
        h = re.sub(r"(?is)<(script|style|head|title)[^>]*>.*?</\1>", "", r["html"])
        h = re.sub(r"(?is)</?(html|body|meta|link)[^>]*>", "", h)
        return h
    return "<div style='white-space:pre-wrap'>" + htmlmod.escape(r["text"]) + "</div>"


def compose_prep(b) -> dict:
    """Campi di una risposta / risposta a tutti / inoltro / bozza da riprendere."""
    mode = b.get("mode", "new")
    if mode == "new":
        return {"ok": True, "c": {"to": [], "cc": [], "bcc": [], "subject": "", "html": "", "atts": []}}
    mid = int(b["id"])
    row = engine.db().one("SELECT * FROM messages WHERE id=?", (mid,))
    raw = engine.raw_of(mid)
    r = parse.render(raw)
    h = r["h"]
    c = {"to": [], "cc": [], "bcc": [], "subject": "", "html": "", "atts": [], "account": row["account"], "reply_to_id": mid}
    acc = accounts.get(row["account"])
    mine = {acc.get("email", "").lower(), *[x.lower() for x in acc.get("alias") or []]}
    if mode in ("reply", "replyall"):
        to = h["reply_to"] or h["from"]
        if row["pec"] == "posta-certificata":  # risposta a una PEC: al mittente vero, non al gestore
            dc = json.loads(row["pec_json"] or "{}")
            if dc.get("risposte") or dc.get("mittente"):
                to = [{"n": "", "a": dc.get("risposte") or dc["mittente"]}]
        if any(x["a"] in mine for x in h["from"]) and h["to"]:
            to = h["to"]
        c["to"] = to
        if mode == "replyall":
            seen = {x["a"] for x in to} | mine
            for x in h["to"] + h["cc"]:
                if x["a"] and x["a"] not in seen:
                    c["cc"].append(x)
                    seen.add(x["a"])
        c["subject"] = _prefix(h["subject"], "reply")
        c["in_reply_to"] = h["msgid"]
        c["refs"] = h["refs"]
        c["quote"] = (f"<div class='mbv-quote'><hr><div style='font-size:90%'>{_quote_header(h, row)}</div><br>"
                      f"<blockquote style='margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex'>{_cid_to_data(_body_html(r), raw)}</blockquote></div>")
    elif mode == "forward":
        c["subject"] = _prefix(h["subject"], "forward")
        c["forward"] = True
        c["quote"] = (f"<div class='mbv-quote'><hr><div style='font-size:90%'>---------- {t('mail.messaggio_inoltrato')} ----------<br>"
                      f"{_quote_header(h, row)}</div><br>{_cid_to_data(_body_html(r), raw)}</div>")
        for a in r["atts"]:
            if a.get("firma") or a.get("inline"):
                continue
            f = att_file({"id": mid, "i": a["i"]})
            c["atts"].append({"path": f["path"], "nome": a["nome"], "size": a["size"]})
        if b.get("as_eml") or row["pec"] == "posta-certificata" and b.get("pec_eml"):
            f = eml_file({"id": mid})
            c["atts"] = [{"path": f["path"], "nome": f["nome"], "size": len(raw)}]
    elif mode == "edit":  # bozza o "Modifica e reinvia"
        c.update(to=h["to"], cc=h["cc"], subject=h["subject"], html=_cid_to_data(_body_html(r), raw), draft_id=mid if row["draft"] or b.get("is_draft") else 0)
        msg = parse.msg_from_bytes(raw)
        c["bcc"] = parse.addrs(msg.get_all("Bcc") or [])
        c["in_reply_to"] = (parse._ids(msg.get("In-Reply-To")) or [""])[0]
        c["refs"] = h["refs"]
        c.pop("reply_to_id", None)
        for a in r["atts"]:
            if a.get("firma") or a.get("inline"):
                continue
            f = att_file({"id": mid, "i": a["i"]})
            c["atts"].append({"path": f["path"], "nome": a["nome"], "size": a["size"]})
    return {"ok": True, "c": c}


def _cid_to_data(h: str, raw: bytes) -> str:
    """Immagini cid: del messaggio citato -> data: (visibili nell'editor; all'invio tornano parti incorporate)."""
    import base64

    def rep(m):
        data, ctype = parse.part_by_cid(raw, m.group(2))
        if not data:
            return m.group(0)
        return f'{m.group(1)}="data:{ctype};base64,{base64.b64encode(data).decode()}"'
    return re.sub(r"""(src)\s*=\s*["']cid:([^"']+)["']""", rep, h, flags=re.I)


def send(b) -> dict:
    c = b["c"]
    acc = accounts.get(c["account"])
    raw, info = compose.build(c, acc)
    info.update(reply_to_id=c.get("reply_to_id"), forward=c.get("forward"))
    send_at = float(b.get("send_at") or 0)
    oid = engine.queue_send(acc["id"], raw, info, send_at=send_at if send_at > time.time() + 30 else 0, draft_id=int(c.get("draft_id") or 0))
    _remember_rcpt(info["rcpt"])
    return {"ok": True, "outbox": oid, "msgid": info["msgid"]}


def _remember_rcpt(rcpt):
    db = engine.db()
    for a in rcpt:
        r = db.one("SELECT id FROM contacts WHERE emails LIKE ? LIMIT 1", (f'%"{a}"%',))
        if r:
            db.x("UPDATE contacts SET used=used+1, last=? WHERE id=?", (time.time(), r["id"]))


def save_draft(b) -> dict:
    c = b["c"]
    acc = accounts.get(c["account"])
    raw, info = compose.build({**c, "draft": True}, acc)
    db = engine.db()
    drafts = engine.folder_by_role(acc["id"], "drafts")
    remote = bool(drafts)
    drafts = drafts or engine.local_folder(acc["id"], "drafts")
    old = db.one("SELECT id, uid FROM messages WHERE id=?", (int(c.get("draft_id") or 0),)) if c.get("draft_id") else None
    mid = engine.add_message(acc["id"], drafts["id"], raw, flags=("\\Seen", "\\Draft"), local=True)
    db.x("UPDATE messages SET draft=1 WHERE id=?", (mid,))
    if old:
        engine.remove_message(old["id"])
    if remote and acc.get("tipo") != "graph":
        blob = db.one("SELECT blob FROM messages WHERE id=?", (mid,))["blob"]
        engine.enqueue(acc["id"], "append", {"folder": drafts["id"], "blob": blob, "mid": mid, "flags": "\\Seen \\Draft",
                                             "replace_uid": old["uid"] if old and old["uid"] > 0 else 0})
    elif remote:
        engine.enqueue(acc["id"], "draft", {"mid": mid, "old_remote": (db.one("SELECT remote_id FROM messages WHERE id=?", (old["id"],)) or {}).get("remote_id") if old else ""})
    return {"ok": True, "draft_id": mid}


def outbox(b) -> dict:
    rows = engine.db().q("SELECT id, account, send_at, created, subject, rcpt, status, error FROM outbox ORDER BY COALESCE(NULLIF(send_at,0), created)")
    for r in rows:
        r["rcpt"] = json.loads(r["rcpt"] or "[]")
    return {"ok": True, "items": rows}


def outbox_op(b) -> dict:
    db = engine.db()
    o = db.one("SELECT * FROM outbox WHERE id=?", (int(b["id"]),))
    if not o:
        return {"ok": True}
    if b["azione"] == "annulla":  # torna bozza
        raw = db.get_raw(o["blob"])
        drafts = engine.folder_by_role(o["account"], "drafts") or engine.local_folder(o["account"], "drafts")
        mid = engine.add_message(o["account"], drafts["id"], raw, flags=("\\Seen", "\\Draft"), local=True)
        db.x("UPDATE messages SET draft=1 WHERE id=?", (mid,))
        db.x("DELETE FROM outbox WHERE id=?", (o["id"],))
        engine.bump()
        return {"ok": True, "draft_id": mid}
    if b["azione"] == "invia_ora":
        db.x("UPDATE outbox SET send_at=0, status='attesa', error='' WHERE id=?", (o["id"],))
        engine.kick(o["account"])
    elif b["azione"] == "elimina":
        db.x("DELETE FROM outbox WHERE id=?", (o["id"],))
    elif b["azione"] == "riprova":
        info = json.loads(o["info"])
        info["tentativi"] = 0
        db.x("UPDATE outbox SET status='attesa', error='', info=? WHERE id=?", (json.dumps(info), o["id"]))
        engine.kick(o["account"])
    elif b["azione"] == "data":
        db.x("UPDATE outbox SET send_at=? WHERE id=?", (float(b["send_at"]), o["id"]))
    engine.bump()
    return {"ok": True}


# ------------------------------------------------------------------ rubrica per il completamento degli indirizzi
def suggest_addresses(q: str) -> dict:
    db = engine.db()
    q = (q or "").strip().lower()
    if len(q) < 1:
        return {"ok": True, "items": []}
    out, seen = [], set()
    for c in db.q("SELECT name, emails, used FROM contacts WHERE deleted=0 AND (name LIKE ? OR emails LIKE ?) ORDER BY used DESC, name LIMIT 15",
                  (f"%{q}%", f"%{q}%")):
        for e in json.loads(c["emails"] or "[]"):
            if e and e.lower() not in seen and (q in e.lower() or q in (c["name"] or "").lower()):
                seen.add(e.lower())
                out.append({"n": c["name"], "a": e, "fonte": "rubrica"})
    for r in db.q("""SELECT from_name n, from_addr a, COUNT(*) k, MAX(date) d FROM messages WHERE (from_addr LIKE ? OR from_name LIKE ?)
                     AND from_addr!='' AND pec='' GROUP BY from_addr ORDER BY k DESC, d DESC LIMIT 15""", (f"%{q}%", f"%{q}%")):
        if r["a"] not in seen:
            seen.add(r["a"])
            out.append({"n": r["n"], "a": r["a"], "fonte": "posta"})
    for r in db.q("""SELECT to_json FROM messages WHERE to_json LIKE ? AND folder_id IN (SELECT id FROM folders WHERE role='sent')
                     ORDER BY date DESC LIMIT 200""", (f"%{q}%",)):
        for x in json.loads(r["to_json"] or "[]"):
            if x["a"] and x["a"] not in seen and (q in x["a"] or q in (x.get("n") or "").lower()):
                seen.add(x["a"])
                out.append({**x, "fonte": "inviati"})
    return {"ok": True, "items": out[:20]}


# ------------------------------------------------------------------ impostazioni
DEFAULT_CATS = [{"nome": "Rosso", "colore": "#e5484d"}, {"nome": "Arancione", "colore": "#f07d2e"}, {"nome": "Giallo", "colore": "#e9b200"},
                {"nome": "Verde", "colore": "#30a46c"}, {"nome": "Blu", "colore": "#3e8ed0"}, {"nome": "Viola", "colore": "#8e4ec6"}]


def settings_get() -> dict:
    db = engine.db()
    return {"ok": True, "s": {
        "categorie": db.setting("categorie", None) or [{**c, "nome": t("mail.cat_" + c["nome"].lower())} for c in DEFAULT_CATS],
        "risposte_rapide": db.setting("risposte_rapide", []),
        "nascondi_ricevute": db.setting("nascondi_ricevute", True),
        "commesse_auto": db.setting("commesse_auto", True),
        "commesse_sottocartella": db.setting("commesse_sottocartella", "Posta"),
        "segna_letto_dopo": db.setting("segna_letto_dopo", 2),
        "immagini_remote": db.setting("immagini_remote", []),
        "soglia_link": db.setting("soglia_link", 20),
        "servizio_link": db.setting("servizio_link", ""),
        "notifiche": db.setting("notifiche", True),
    }}


def settings_set(b) -> dict:
    db = engine.db()
    for k, v in (b.get("s") or {}).items():
        db.set_setting(k, v)
    engine.bump()
    return {"ok": True}


# ------------------------------------------------------------------ prova di un account (job)
def test_account(acc: dict, update):
    from .imapc import Imap
    res = {"imap": None, "smtp": None}
    acc = {**acc, "_password": acc.get("password") or None}
    if acc.get("id") and not acc["_password"]:
        acc["_password"] = accounts.secret(acc["id"]).get("password")
    tf = engine.token_fn(acc) if acc.get("oauth") and acc.get("id") else None
    if acc.get("tipo") == "graph":
        from .graphmail import GraphProvider
        update(0.3, t("srv_mail.prova_graph"))
        res["graph"] = GraphProvider(acc).test()
        return res
    update(0.2, t("srv_mail.prova_imap"))
    try:
        with Imap(acc, tf, timeout=25) as c:
            res["imap"] = {"ok": True, "cartelle": len(c.folders())}
    except MailError as e:
        res["imap"] = {"ok": False, "errore": str(e), "auth": e.auth}
    update(0.6, t("srv_mail.prova_smtp"))
    import smtplib
    try:
        from . import accounts as A
        host, port, sec = acc.get("smtp"), int(acc.get("smtp_port") or 465), acc.get("smtp_sec", "ssl")
        s = smtplib.SMTP_SSL(host, port, timeout=20, context=A.tls_context(acc.get("_insicuro"))) if sec == "ssl" else smtplib.SMTP(host, port, timeout=20)
        try:
            s.ehlo()
            if sec == "starttls":
                s.starttls(context=A.tls_context(acc.get("_insicuro")))
                s.ehlo()
            if tf:
                import base64
                user = acc.get("utente_smtp") or acc.get("utente") or acc.get("email")
                code, resp = s.docmd("AUTH", "XOAUTH2 " + base64.b64encode(f"user={user}\x01auth=Bearer {tf()}\x01\x01".encode()).decode())
                if code != 235:
                    raise smtplib.SMTPAuthenticationError(code, resp)
            elif s.has_extn("auth"):
                sec_ = accounts.secret(acc["id"]) if acc.get("id") else {}
                pw = acc.get("password_smtp") or sec_.get("password_smtp") or acc["_password"]
                s.login(acc.get("utente_smtp") or acc.get("utente") or acc.get("email"), pw)
            res["smtp"] = {"ok": True}
        finally:
            try:
                s.quit()
            except Exception:  # noqa: BLE001
                pass
    except smtplib.SMTPAuthenticationError as e:
        res["smtp"] = {"ok": False, "errore": t("srv_mail.accesso_rifiutato", e.smtp_error.decode("utf-8", "replace") if isinstance(e.smtp_error, bytes) else e.smtp_error), "auth": True}
    except (OSError, smtplib.SMTPException) as e:
        res["smtp"] = {"ok": False, "errore": t("srv_mail.server_non_raggiungibile", f"{acc.get('smtp')}:{acc.get('smtp_port')}", e)}
    return res


# ------------------------------------------------------------------ smistamento
def handle(op: str, q: dict, b: dict):
    engine.start()
    if op == "status":
        st = engine.status()
        st["nuovi"] = engine.take_new() if q.get("nuovi") else []
        due = engine.db().q("SELECT id, subject, from_name, remind_at FROM messages WHERE remind_at>0 AND remind_at<=?", (time.time(),))
        st["promemoria"] = due
        from . import calapi
        st["eventi"] = calapi.upcoming()
        st["nonletti"] = engine.db().one("SELECT COUNT(*) n FROM messages WHERE seen=0 AND pec NOT IN (%s) AND folder_id IN (SELECT id FROM folders WHERE role='inbox')"
                                         % ",".join("?" * len(engine.RECEIPTS)), engine.RECEIPTS)["n"]
        return {"ok": True, **st}
    if op == "folders":
        return folders()
    if op == "list":
        return list_messages(b or q)
    if op == "thread":
        return thread_messages(b or q)
    if op == "message":
        return message(b or q)
    if op == "part":
        return part(q)
    if op == "img":
        return img_proxy(q)
    if op == "att_file":
        return att_file(b or q)
    if op == "eml_file":
        return eml_file(b or q)
    if op == "save_atts":
        return save_atts(b)
    if op == "set":
        ids = [int(x) for x in b["ids"]]
        engine.set_flags(ids, **{k: v for k, v in b.items() if k != "ids"})
        return {"ok": True}
    if op == "move":
        engine.move([int(x) for x in b["ids"]], int(b["folder"]))
        return {"ok": True}
    if op == "delete":
        engine.delete([int(x) for x in b["ids"]], permanent=bool(b.get("permanent")))
        return {"ok": True}
    if op == "archive":  # cartella Archivio dell'account (come il tasto Backspace di Outlook)
        for aid, mids in engine._by_account([int(x) for x in b["ids"]]).items():
            f = engine.folder_by_role(aid, "archive")
            if not f:
                path = "Archive"
                engine.enqueue(aid, "folder_create", {"path": path})
                f = {"id": engine.ensure_folder(aid, path, path, "archive")}
            engine.move(mids, f["id"])
        return {"ok": True}
    if op == "sync":
        engine.kick(b.get("account") or q.get("account"), "sync")
        return {"ok": True}
    if op == "folder_create":
        aid = b["account"]
        parent = engine.db().one("SELECT * FROM folders WHERE id=?", (int(b["parent"]),)) if b.get("parent") else None
        path = (parent["path"] + parent["delim"] + b["name"]) if parent else b["name"]
        engine.ensure_folder(aid, path, b["name"], "", parent["delim"] if parent else "/")
        engine.enqueue(aid, "folder_create", {"path": path})
        engine.bump()
        return {"ok": True}
    if op == "folder_delete":
        f = engine.db().one("SELECT * FROM folders WHERE id=?", (int(b["id"]),))
        if f["role"]:
            raise MailError(t("srv_mail.cartella_di_sistema"))
        for m in engine.db().q("SELECT id FROM messages WHERE folder_id=?", (f["id"],)):
            engine.remove_message(m["id"])
        engine.db().x("DELETE FROM folders WHERE id=?", (f["id"],))
        engine.enqueue(f["account"], "folder_delete", {"path": f["path"], "remote_id": f["remote_id"]})
        return {"ok": True}
    if op == "folder_rename":
        f = engine.db().one("SELECT * FROM folders WHERE id=?", (int(b["id"]),))
        new = f["path"][: len(f["path"]) - len(f["name"])] + b["name"]
        engine.db().x("UPDATE folders SET path=?, name=? WHERE id=?", (new, b["name"], f["id"]))
        engine.enqueue(f["account"], "folder_rename", {"old": f["path"], "new": new, "remote_id": f["remote_id"], "name": b["name"]})
        engine.bump()
        return {"ok": True}
    if op == "mark_folder_read":
        ids = [r["id"] for r in engine.db().q("SELECT id FROM messages WHERE folder_id=? AND seen=0", (int(b["folder"]),))]
        engine.set_flags(ids, seen=1)
        return {"ok": True}
    if op == "compose":
        return compose_prep(b)
    if op == "send":
        return send(b)
    if op == "draft":
        return save_draft(b)
    if op == "outbox":
        return outbox(b)
    if op == "outbox_op":
        return outbox_op(b)
    if op == "suggest":
        return suggest_addresses(q.get("q", ""))
    if op == "accounts":
        return {"ok": True, "account": [accounts.public(a) for a in accounts.all_accounts()], "preset": accounts.presets()}
    if op == "account_save":
        acc = accounts.save_account(b)
        engine.kick(acc["id"], "sync")
        return {"ok": True, "account": accounts.public(acc)}
    if op == "account_delete":
        accounts.delete_account(b["id"])
        engine.reset_account(b["id"])
        return {"ok": True}
    if op == "account_order":
        accounts.reorder(b["ids"])
        engine.bump()
        return {"ok": True}
    if op == "autoconfig":
        return {"ok": True, "job": jobs.start(lambda update: accounts.autoconfig(b["email"], update))}
    if op == "account_test":
        return {"ok": True, "job": jobs.start(test_account, b)}
    if op == "oauth_login":
        from . import oauth
        return oauth.login_start(b)
    if op == "oauth_status":
        from . import oauth
        return oauth.status()
    if op == "commesse":
        return {"ok": True, "items": commesse.all_()}
    if op == "commessa_save":
        return {"ok": True, **commesse.save(b)}
    if op == "commessa_delete":
        commesse.delete(b["id"])
        return {"ok": True}
    if op == "commessa_archivia":
        return commesse.archive([int(x) for x in b["ids"]], b["commessa"], b.get("allegati", True))
    if op == "rules":
        rows = engine.db().q("SELECT * FROM rules ORDER BY ord, id")
        for r in rows:
            r["cond"], r["azioni"] = json.loads(r["cond"] or "{}"), json.loads(r["azioni"] or "{}")
        return {"ok": True, "items": rows}
    if op == "rule_save":
        db = engine.db()
        vals = (b.get("nome", ""), b.get("account", "*"), int(b.get("attiva", 1)), json.dumps(b.get("cond") or {}),
                json.dumps(b.get("azioni") or {}), int(b.get("ord", 0)), int(b.get("stop", 0)))
        if b.get("id"):
            db.x("UPDATE rules SET nome=?, account=?, attiva=?, cond=?, azioni=?, ord=?, stop=? WHERE id=?", (*vals, int(b["id"])))
            rid = int(b["id"])
        else:
            rid = db.x("INSERT INTO rules(nome, account, attiva, cond, azioni, ord, stop) VALUES(?,?,?,?,?,?,?)", vals)
        return {"ok": True, "id": rid}
    if op == "rule_delete":
        engine.db().x("DELETE FROM rules WHERE id=?", (int(b["id"]),))
        return {"ok": True}
    if op == "rule_run":
        return {"ok": True, "n": rules.run_on_folder(int(b["id"]), int(b["folder"]))}
    if op == "settings":
        return settings_get()
    if op == "settings_set":
        return settings_set(b)
    if op == "open_url":
        url = b.get("url", "")
        if urlparse(url).scheme in ("http", "https"):
            webbrowser.open(url)
        return {"ok": True}
    if op == "pec_status":
        return {"ok": True, **engine.pec_status(b["account"], b["msgid"])}
    if op == "bigfile":
        from . import bigfile
        return {"ok": True, "job": jobs.start(bigfile.upload, b["path"], b.get("svc", ""))}
    if op == "bigfile_services":
        from . import bigfile
        return bigfile.services()
    if op == "guide_path":
        from ..paths import UI_DIR
        return {"ok": True, "path": str(UI_DIR / "guide" / "posta.md")}
    if op == "mdn":
        return send_mdn(b)
    if op == "import_eml":
        return import_eml(b)
    if op in ("cal", "cal_events", "cal_event", "cal_save", "cal_delete", "cal_reply", "contacts", "contact_save", "contact_delete", "dav_discover"):
        from . import calapi
        return calapi.handle(op, q, b)
    raise MailError(t("srv_mail.operazione_sconosciuta"))


def send_mdn(b) -> dict:
    """Conferma di lettura (RFC 8098, multipart/report disposition-notification) chiesta con Disposition-Notification-To."""
    from email.mime.base import MIMEBase
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.utils import formataddr, formatdate, make_msgid
    mid = int(b["id"])
    row = engine.db().one("SELECT account FROM messages WHERE id=?", (mid,))
    acc = accounts.get(row["account"])
    r = parse.render(engine.raw_of(mid))
    h = r["h"]
    to = parse.addrs(h["notify"])
    if not to:
        raise MailError(t("srv_mail.nessun_destinatario"))
    m = MIMEMultipart("report", report_type="disposition-notification")
    m["From"] = formataddr((acc.get("nome") or "", acc["email"]))
    m["To"] = formataddr((to[0]["n"], to[0]["a"]))
    m["Subject"] = t("mail.letto_oggetto", h["subject"])
    m["Date"] = formatdate(localtime=True)
    m["Message-ID"] = make_msgid(domain=acc["email"].split("@")[-1])
    m.attach(MIMEText(t("mail.letto_testo", h["subject"], datetime.now().strftime("%d/%m/%Y %H:%M")), "plain", "utf-8"))
    rep = MIMEBase("message", "disposition-notification")
    crlf = "\r\n"
    rep.set_payload(crlf.join([f"Reporting-UA: MB Visual", f"Original-Recipient: rfc822;{acc['email']}", f"Final-Recipient: rfc822;{acc['email']}",
                               f"Original-Message-ID: {h['msgid']}", "Disposition: manual-action/MDN-sent-manually; displayed"]) + crlf)
    m.attach(rep)
    engine.queue_send(acc["id"], m.as_bytes(), {"msgid": m["Message-ID"], "rcpt": [to[0]["a"]], "from": acc["email"]})
    sent = engine.db().setting("mdn_inviati", [])
    engine.db().set_setting("mdn_inviati", (sent + [h["msgid"]])[-2000:])
    return {"ok": True}


def import_eml(b) -> dict:
    """File .eml trascinati su una cartella: si aggiungono (e si caricano sul server)."""
    f = engine.db().one("SELECT * FROM folders WHERE id=?", (int(b["folder"]),))
    n = 0
    for p in b["paths"]:
        raw = Path(p).read_bytes()
        mid = engine.add_message(f["account"], f["id"], raw, local=True)
        blob = engine.db().one("SELECT blob FROM messages WHERE id=?", (mid,))["blob"]
        engine.enqueue(f["account"], "append", {"folder": f["id"], "blob": blob, "mid": mid})
        n += 1
    return {"ok": True, "n": n}
