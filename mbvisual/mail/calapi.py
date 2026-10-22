"""Calendario e contatti della posta: risposte agli inviti, eventi e rubrica locali (sincronizzati con CalDAV/CardDAV o
Microsoft Graph da calsync.py)."""
import json
import time

from . import accounts, compose, engine, ical, parse
from .imapc import MailError
from ..i18n import t

PARTSTAT = {"ACCEPTED": "ACCEPTED", "TENTATIVE": "TENTATIVE", "DECLINED": "DECLINED"}


def local_calendar(aid) -> int:
    """Calendario dell'account (quello del server se c'e', altrimenti uno locale)."""
    db = engine.db()
    r = db.one("SELECT id FROM calendars WHERE account=? AND kind='cal' ORDER BY readonly, id LIMIT 1", (aid,))
    if r:
        return r["id"]
    return db.x("INSERT INTO calendars(account, href, name, color, kind) VALUES(?,?,?,?,?)", (aid, "locale", t("mail.calendario"), "#f07d2e", "cal"))


def save_event(cal_id, ev: dict, ics: str = "", dirty=1) -> int:
    db = engine.db()
    old = db.one("SELECT id FROM events WHERE cal_id=? AND uid=? AND deleted=0", (cal_id, ev.get("uid", "")))
    vals = (ev.get("summary", ""), ev.get("location", ""), ev.get("start", 0), ev.get("end", 0), int(bool(ev.get("allday"))),
            ev.get("rrule", ""), ics, dirty)
    if old:
        db.x("UPDATE events SET summary=?, location=?, start=?, end=?, allday=?, rrule=?, ics=?, dirty=? WHERE id=?", (*vals, old["id"]))
        eid = old["id"]
    else:
        eid = db.x("INSERT INTO events(cal_id, uid, summary, location, start, end, allday, rrule, ics, dirty) VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (cal_id, ev.get("uid", ""), *vals))
    engine.bump()
    return eid


def cal_reply(b) -> dict:
    """Risposta a un invito ricevuto: REPLY all'organizzatore (se richiesto) ed evento nel calendario dell'account."""
    mid = int(b["id"])
    row = engine.db().one("SELECT account FROM messages WHERE id=?", (mid,))
    raw = engine.raw_of(mid)
    data, _, _ = parse.get_part(raw, str(b["i"]))
    evs = ical.events(data.decode("utf-8", "replace"))
    if not evs:
        raise MailError(t("srv_mail.invito_non_valido"))
    ev = evs[0]
    acc = accounts.get(row["account"])
    ans = b.get("risposta", "ACCEPTED")
    cal = local_calendar(acc["id"])
    if ev.get("method") == "CANCEL":
        engine.db().x("UPDATE events SET deleted=1, dirty=1 WHERE uid=?", (ev.get("uid", ""),))
        engine.bump()
        return {"ok": True}
    if acc.get("tipo") == "graph" and ans in PARTSTAT and _graph_reply(acc, ev, ans):
        return {"ok": True}
    if ans in PARTSTAT:
        org = ev.get("organizer") or {}
        if org.get("a") and "@" in org["a"]:
            ics = ical.reply(ev, acc["email"], acc.get("nome", ""), PARTSTAT[ans])
            subj = t("mail.oggetto_risposta_" + ans, ev.get("summary", ""))
            raw2, info = compose.build({"to": [org], "subject": subj, "text": subj,
                                        "ics": [{"data": ics, "method": "REPLY", "nome": "risposta.ics"}]}, acc)
            engine.queue_send(acc["id"], raw2, info)
    if ans != "DECLINED":
        mine = dict(ev)
        save_event(cal, mine, data.decode("utf-8", "replace"))
    else:
        engine.db().x("UPDATE events SET deleted=1, dirty=1 WHERE cal_id=? AND uid=?", (cal, ev.get("uid", "")))
    return {"ok": True}


def _graph_reply(acc, ev, ans) -> bool:
    """Microsoft 365: l'invito e' gia' nel calendario di Exchange; si risponde con accept/tentativelyAccept/decline."""
    from urllib.parse import quote
    from . import calsync
    from .graphmail import GraphProvider
    g = GraphProvider(acc)
    uid = (ev.get("uid") or "").replace("'", "''")
    j = g.call("GET", "/me/events?$select=id&$filter=" + quote(f"iCalUId eq '{uid}'"))
    items = j.get("value", []) if isinstance(j, dict) else []
    if not items:
        return False
    action = {"ACCEPTED": "accept", "TENTATIVE": "tentativelyAccept", "DECLINED": "decline"}[ans]
    g.call("POST", f"/me/events/{items[0]['id']}/{action}", js={"sendResponse": True})
    calsync._LAST.pop(acc["id"], None)
    engine.kick(acc["id"], "sync")
    return True


def events_between(b) -> dict:
    db = engine.db()
    a, z = float(b.get("da", 0)), float(b.get("a", time.time() + 86400 * 60))
    rows = db.q("""SELECT e.id, e.uid, e.summary, e.location, e.start, e.end, e.allday, e.rrule, c.id AS cal, c.name AS cal_name, c.color, c.account,
                   c.readonly, CASE WHEN e.rrule NOT IN ('', 'occ') THEN e.ics ELSE '' END AS ics
                   FROM events e JOIN calendars c ON c.id=e.cal_id WHERE e.deleted=0 AND ((e.rrule NOT IN ('', 'occ') AND e.start<=?) OR (e.end>=? AND e.start<=?))
                   ORDER BY e.start""", (z, a, z))
    return {"ok": True, "items": rows, "calendari": db.q("SELECT id, account, name, color, readonly, kind FROM calendars WHERE kind='cal'")}


def event_detail(b) -> dict:
    db = engine.db()
    e = db.one("SELECT e.*, c.name AS cal_name, c.color, c.readonly, c.account FROM events e JOIN calendars c ON c.id=e.cal_id WHERE e.id=?", (int(b["id"]),))
    if not e:
        raise MailError(t("srv_mail.evento_non_trovato"))
    ev = (ical.events(e["ics"]) or [{}])[0] if e["ics"] else {}
    return {"ok": True, "e": {**e, "description": ev.get("description", ""), "attendees": ev.get("attendees", []), "organizer": ev.get("organizer"),
                              "promemoria": _alarm(e["ics"])}}


def _alarm(ics):
    import re
    m = re.search(r"TRIGGER[^:]*:-?PT?(\d+)([MHD])", ics or "")
    if not m:
        return -1
    return int(m.group(1)) * {"M": 1, "H": 60, "D": 1440}[m.group(2)]


def upcoming(minutes=15) -> list:
    """Eventi che iniziano a breve (avviso come i promemoria di Outlook)."""
    now = time.time()
    return engine.db().q("""SELECT e.id, e.summary, e.location, e.start FROM events e JOIN calendars c ON c.id=e.cal_id
                            WHERE e.deleted=0 AND e.allday=0 AND e.start>? AND e.start<=?""", (now - 60, now + minutes * 60))


def handle(op, q, b):
    if op == "cal_event":
        return event_detail(b)
    if op == "cal_reply":
        return cal_reply(b)
    if op in ("cal", "cal_events"):
        return events_between(b or q)
    if op == "cal_save":
        from . import calsync
        return calsync.save_event_ui(b)
    if op == "cal_delete":
        from . import calsync
        return calsync.delete_event_ui(b)
    if op in ("contacts", "contact_save", "contact_delete", "dav_discover"):
        from . import calsync
        return calsync.handle(op, q, b)
    raise MailError(t("srv_mail.operazione_sconosciuta"))


_ = json
