"""Calendari e rubriche degli account: CalDAV/CardDAV (RFC 4791/6352, anche Google con OAuth), Microsoft Graph
(Microsoft 365 / Outlook.com) o solo locali. Le modifiche fatte in MB Desk sono "dirty" e salgono al giro successivo.

Tabelle (store.py): calendars (kind "cal" = calendario, "book" = rubrica; href = URL CalDAV/CardDAV o id di Graph o
"locale"), events (uid, href, etag, ics, start/end, rrule; dirty/deleted da caricare), contacts (book_id, vcf, nome,
email, telefoni, azienda).
"""
import base64
import json
import re
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse

from .. import cloud
from ..i18n import t
from . import accounts, compose, engine, ical
from .imapc import MailError

NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav", "a": "urn:ietf:params:xml:ns:carddav", "cs": "http://calendarserver.org/ns/",
      "ic": "http://apple.com/ns/ical/"}
PAST, FUTURE = 120, 400  # giorni sincronizzati attorno a oggi


# ------------------------------------------------------------------ vCard minima (lettura e scrittura)
def vcard_parse(text: str) -> dict:
    out = {"uid": "", "name": "", "emails": [], "phones": [], "org": ""}
    n = ""
    for line in ical.unfold(text):
        name, params, value = ical.parse_line(line)
        base = (name or "").split(".")[-1]
        if base == "UID":
            out["uid"] = value.strip()
        elif base == "FN":
            out["name"] = ical.unesc(value).strip()
        elif base == "N":
            parts = [ical.unesc(x) for x in value.split(";")]
            n = " ".join(x for x in (parts[1] if len(parts) > 1 else "", parts[0]) if x).strip()
        elif base == "EMAIL":
            out["emails"].append(value.strip().lower())
        elif base == "TEL":
            out["phones"].append(value.replace("tel:", "").strip())
        elif base == "ORG":
            out["org"] = ical.unesc(value.split(";")[0]).strip()
    out["name"] = out["name"] or n or (out["emails"][0] if out["emails"] else out["org"])
    return out


def vcard_build(c: dict, old: str = "") -> str:
    """vCard 3.0; le proprieta' del vecchio vCard che MB Desk non gestisce restano com'erano."""
    keep = []
    if old:
        for line in ical.unfold(old):
            nm = (ical.parse_line(line)[0] or "").split(".")[-1]
            if nm and nm not in ("BEGIN", "END", "VERSION", "UID", "FN", "N", "EMAIL", "TEL", "ORG", "TITLE", "NOTE", "ADR", "PRODID", "REV"):
                keep.append(line)
    name = c.get("name") or ""
    parts = name.rsplit(" ", 1)
    lines = ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//MB Desk//Contatti//IT", f"UID:{c.get('uid') or uuid.uuid4().hex}",
             "FN:" + ical.esc(name), "N:" + (ical.esc(parts[-1]) + ";" + ical.esc(parts[0]) if len(parts) > 1 else ical.esc(name)) + ";;;"]
    if c.get("org"):
        lines.append("ORG:" + ical.esc(c["org"]))
    if c.get("title"):
        lines.append("TITLE:" + ical.esc(c["title"]))
    for e in c.get("emails") or []:
        lines.append("EMAIL;TYPE=INTERNET:" + e)
    for p in c.get("phones") or []:
        lines.append("TEL;TYPE=VOICE:" + p)
    if c.get("address"):
        lines.append("ADR;TYPE=WORK:;;" + ical.esc(c["address"]) + ";;;;")
    if c.get("note"):
        lines.append("NOTE:" + ical.esc(c["note"]))
    lines += keep
    lines.append("REV:" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    lines.append("END:VCARD")
    return "\r\n".join(ical.fold(x) for x in lines) + "\r\n"


# ------------------------------------------------------------------ libreria locale
def book_of(aid, href="locale-rubrica", name=None) -> int:
    db = engine.db()
    r = db.one("SELECT id FROM calendars WHERE account=? AND kind='book' AND href=?", (aid, href))
    if r:
        return r["id"]
    return db.x("INSERT INTO calendars(account, href, name, kind) VALUES(?,?,?,'book')", (aid, href, name or t("mail.contatti")))


def store_contact(book, vcf, href="", etag="", dirty=0, cid=None) -> int:
    db = engine.db()
    c = vcard_parse(vcf)
    vals = (c["uid"], c["name"], json.dumps(c["emails"]), json.dumps(c["phones"]), c["org"], vcf, href, etag, dirty)
    if cid is None:
        r = db.one("SELECT id FROM contacts WHERE book_id=? AND ((href!='' AND href=?) OR uid=?) AND deleted=0", (book, href, c["uid"]))
        cid = r["id"] if r else None
    if cid:
        db.x("UPDATE contacts SET uid=?, name=?, emails=?, phones=?, org=?, vcf=?, href=?, etag=?, dirty=? WHERE id=?", (*vals, cid))
        return cid
    return db.x("INSERT INTO contacts(uid, name, emails, phones, org, vcf, href, etag, dirty, book_id) VALUES(?,?,?,?,?,?,?,?,?,?)", (*vals, book))


# ------------------------------------------------------------------ WebDAV
class Dav:
    def __init__(self, acc, base):
        self.acc, self.base = acc, base
        sec = accounts.secret(acc["id"])
        if acc.get("oauth") == "google":
            from . import oauth
            self.auth = lambda: "Bearer " + oauth.access_token(acc)
        else:
            user = acc.get("dav_utente") or acc.get("utente") or acc.get("email")
            pw = sec.get("dav_password") or sec.get("password") or ""
            tok = base64.b64encode(f"{user}:{pw}".encode()).decode()
            self.auth = lambda: "Basic " + tok

    def req(self, method, url, body=None, depth=None, headers=None, ok=(200, 201, 204, 207)):
        h = {"Authorization": self.auth(), "User-Agent": "MBVisual", **(headers or {})}
        if body is not None and "Content-Type" not in h:
            h["Content-Type"] = "application/xml; charset=utf-8"
        if depth is not None:
            h["Depth"] = str(depth)
        try:
            st, hd, b = cloud._http(method, urljoin(self.base, url), h, body.encode("utf-8") if isinstance(body, str) else body, timeout=60)
        except cloud.CloudError as e:
            raise MailError(str(e), offline=True) from e
        if st == 401:
            raise MailError(t("srv_mail.dav_accesso_rifiutato"), auth=True)
        if st not in ok:
            raise MailError(t("srv_mail.dav_errore", method, st))
        return st, hd, b

    def propfind(self, url, props, depth=0):
        body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' \
               'xmlns:a="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"><d:prop>' + \
               "".join(f"<{p}/>" for p in props) + "</d:prop></d:propfind>"
        _, _, b = self.req("PROPFIND", url, body, depth)
        return responses(b)


def responses(xml_bytes) -> list:
    root = ET.fromstring(xml_bytes)
    out = []
    for r in root.findall("d:response", NS):
        href = (r.findtext("d:href", "", NS) or "").strip()
        props = {}
        for ps in r.findall("d:propstat", NS):
            if "200" not in (ps.findtext("d:status", "", NS) or "200"):
                continue
            for p in ps.find("d:prop", NS) or []:
                props[p.tag] = p
        out.append((href, props))
    return out


def _href_in(el):
    h = el.find("d:href", NS) if el is not None else None
    return h.text.strip() if h is not None and h.text else None


def _restype(props):
    rt = props.get("{DAV:}resourcetype")
    return {c.tag for c in rt} if rt is not None else set()


def discover(dav: Dav, kind="cal") -> list:
    """Collezioni (calendari o rubriche) raggiungibili dall'URL dell'account."""
    home_prop = "c:calendar-home-set" if kind == "cal" else "a:addressbook-home-set"
    want = "{urn:ietf:params:xml:ns:caldav}calendar" if kind == "cal" else "{urn:ietf:params:xml:ns:carddav}addressbook"
    home_tag = "{urn:ietf:params:xml:ns:caldav}calendar-home-set" if kind == "cal" else "{urn:ietf:params:xml:ns:carddav}addressbook-home-set"
    r = dav.propfind("", ["d:current-user-principal", home_prop, "d:resourcetype", "d:displayname"], 0)
    href, props = r[0] if r else ("", {})
    if want in _restype(props):
        return [{"href": urljoin(dav.base, href or dav.base), "name": (props.get("{DAV:}displayname").text if props.get("{DAV:}displayname") is not None else "") or ""}]
    home = _href_in(props.get(home_tag))
    if not home:
        princ = _href_in(props.get("{DAV:}current-user-principal"))
        if princ:
            pr = dav.propfind(princ, [home_prop], 0)
            home = _href_in(pr[0][1].get(home_tag)) if pr else None
    home = home or dav.base
    out = []
    for h, p in dav.propfind(home, ["d:resourcetype", "d:displayname", "cs:getctag", "ic:calendar-color", "d:current-user-privilege-set",
                                    "c:supported-calendar-component-set"], 1):
        if want not in _restype(p):
            continue
        if kind == "cal":
            comps = p.get("{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set")
            if comps is not None and len(comps) and not any(x.get("name") == "VEVENT" for x in comps):
                continue
        dn = p.get("{DAV:}displayname")
        col = p.get("{http://apple.com/ns/ical/}calendar-color")
        ctag = p.get("{http://calendarserver.org/ns/}getctag")
        priv = p.get("{DAV:}current-user-privilege-set")
        ro = priv is not None and not any(x.tag in ("{DAV:}write", "{DAV:}write-content", "{DAV:}all") for x in priv.iter())
        out.append({"href": urljoin(dav.base, h), "name": (dn.text if dn is not None else "") or h.rstrip("/").split("/")[-1],
                    "color": (col.text or "")[:7] if col is not None else "", "ctag": ctag.text if ctag is not None else "", "readonly": ro})
    return out


def _range():
    a = datetime.now(timezone.utc) - timedelta(days=PAST)
    z = datetime.now(timezone.utc) + timedelta(days=FUTURE)
    return a.strftime("%Y%m%dT%H%M%SZ"), z.strftime("%Y%m%dT%H%M%SZ")


def sync_caldav(acc):
    db = engine.db()
    dav = Dav(acc, acc["caldav"])
    cals = discover(dav, "cal")
    seen = set()
    for c in cals:
        r = db.one("SELECT * FROM calendars WHERE account=? AND kind='cal' AND href=?", (acc["id"], c["href"]))
        cid = r["id"] if r else db.x("INSERT INTO calendars(account, href, name, color, kind, readonly) VALUES(?,?,?,?,'cal',?)",
                                     (acc["id"], c["href"], c["name"], c["color"] or "#3e8ed0", int(c["readonly"])))
        seen.add(cid)
        db.x("UPDATE calendars SET name=?, readonly=? WHERE id=?", (c["name"], int(c["readonly"]), cid))
        _push_events(dav, cid, c["href"])
        if r and r["ctag"] and c["ctag"] and r["ctag"] == c["ctag"]:
            continue
        a, z = _range()
        body = ('<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                '<d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
                f'<c:time-range start="{a}" end="{z}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')
        _, _, b = dav.req("REPORT", c["href"], body, 1)
        hrefs = set()
        for h, p in responses(b):
            data = p.get("{urn:ietf:params:xml:ns:caldav}calendar-data")
            et = p.get("{DAV:}getetag")
            if data is None or not data.text:
                continue
            full = urljoin(c["href"], h)
            hrefs.add(full)
            for ev in ical.events(data.text)[:1]:
                row = db.one("SELECT id, dirty FROM events WHERE cal_id=? AND href=?", (cid, full))
                if row and row["dirty"]:
                    continue
                vals = (ev.get("uid", ""), ev.get("summary", ""), ev.get("location", ""), ev.get("start", 0), ev.get("end", 0),
                        int(bool(ev.get("allday"))), ev.get("rrule", ""), data.text, et.text if et is not None else "")
                if row:
                    db.x("UPDATE events SET uid=?, summary=?, location=?, start=?, end=?, allday=?, rrule=?, ics=?, etag=?, deleted=0 WHERE id=?", (*vals, row["id"]))
                else:
                    db.x("INSERT INTO events(uid, summary, location, start, end, allday, rrule, ics, etag, cal_id, href) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                         (*vals, cid, full))
        for row in db.q("SELECT id, href FROM events WHERE cal_id=? AND href!='' AND dirty=0", (cid,)):
            if row["href"] not in hrefs:
                db.x("DELETE FROM events WHERE id=?", (row["id"],))
        db.x("UPDATE calendars SET ctag=? WHERE id=?", (c["ctag"], cid))
    for r in db.q("SELECT id FROM calendars WHERE account=? AND kind='cal' AND href LIKE 'http%'", (acc["id"],)):
        if r["id"] not in seen:
            db.x("DELETE FROM events WHERE cal_id=?", (r["id"],))
            db.x("DELETE FROM calendars WHERE id=?", (r["id"],))
    engine.bump()


def _push_events(dav, cid, href):
    db = engine.db()
    for e in db.q("SELECT * FROM events WHERE cal_id=? AND dirty=1", (cid,)):
        if e["deleted"]:
            if e["href"]:
                dav.req("DELETE", e["href"], headers={"If-Match": e["etag"]} if e["etag"] else None, ok=(200, 204, 404, 412))
            db.x("DELETE FROM events WHERE id=?", (e["id"],))
            continue
        url = e["href"] or (href.rstrip("/") + "/" + re.sub(r"[^\w.@-]", "_", e["uid"] or uuid.uuid4().hex) + ".ics")
        hdr = {"Content-Type": "text/calendar; charset=utf-8"}
        if e["etag"]:
            hdr["If-Match"] = e["etag"]
        elif not e["href"]:
            hdr["If-None-Match"] = "*"
        _, hd, _ = dav.req("PUT", url, e["ics"], headers=hdr, ok=(200, 201, 204))
        db.x("UPDATE events SET dirty=0, href=?, etag=? WHERE id=?", (url, (hd.get("ETag") if hd else "") or "", e["id"]))


def sync_carddav(acc):
    db = engine.db()
    dav = Dav(acc, acc["carddav"])
    for bk in discover(dav, "book"):
        book = book_of(acc["id"], bk["href"], bk["name"])
        for c in db.q("SELECT * FROM contacts WHERE book_id=? AND dirty=1", (book,)):
            if c["deleted"]:
                if c["href"]:
                    dav.req("DELETE", c["href"], ok=(200, 204, 404, 412))
                db.x("DELETE FROM contacts WHERE id=?", (c["id"],))
                continue
            url = c["href"] or (bk["href"].rstrip("/") + "/" + re.sub(r"[^\w.@-]", "_", c["uid"] or uuid.uuid4().hex) + ".vcf")
            hdr = {"Content-Type": "text/vcard; charset=utf-8", **({"If-Match": c["etag"]} if c["etag"] else {})}
            _, hd, _ = dav.req("PUT", url, c["vcf"], headers=hdr, ok=(200, 201, 204))
            db.x("UPDATE contacts SET dirty=0, href=?, etag=? WHERE id=?", (url, (hd.get("ETag") if hd else "") or "", c["id"]))
        body = ('<?xml version="1.0" encoding="utf-8"?><a:addressbook-query xmlns:d="DAV:" xmlns:a="urn:ietf:params:xml:ns:carddav">'
                "<d:prop><d:getetag/><a:address-data/></d:prop></a:addressbook-query>")
        _, _, b = dav.req("REPORT", bk["href"], body, 1)
        hrefs = set()
        for h, p in responses(b):
            data = p.get("{urn:ietf:params:xml:ns:carddav}address-data")
            if data is None or not data.text:
                continue
            full = urljoin(bk["href"], h)
            hrefs.add(full)
            row = db.one("SELECT id, dirty FROM contacts WHERE book_id=? AND href=?", (book, full))
            if row and row["dirty"]:
                continue
            et = p.get("{DAV:}getetag")
            store_contact(book, data.text, full, et.text if et is not None else "", 0, row["id"] if row else None)
        for row in db.q("SELECT id, href FROM contacts WHERE book_id=? AND href!='' AND dirty=0", (book,)):
            if row["href"] not in hrefs:
                db.x("DELETE FROM contacts WHERE id=?", (row["id"],))
    engine.bump()


# ------------------------------------------------------------------ Microsoft Graph
def sync_graph(acc):
    from .graphmail import GraphProvider
    g = GraphProvider(acc)
    db = engine.db()
    seen = set()
    for c in g.pages("/me/calendars?$top=100"):
        r = db.one("SELECT id FROM calendars WHERE account=? AND kind='cal' AND href=?", (acc["id"], c["id"]))
        cid = r["id"] if r else db.x("INSERT INTO calendars(account, href, name, color, kind, readonly) VALUES(?,?,?,?,'cal',?)",
                                     (acc["id"], c["id"], c.get("name", ""), c.get("hexColor") or "#3e8ed0", int(not c.get("canEdit", True))))
        seen.add(cid)
        for e in db.q("SELECT * FROM events WHERE cal_id=? AND dirty=1", (cid,)):
            if e["deleted"]:
                if e["href"]:
                    g.call("DELETE", f"/me/events/{e['href']}", ok=(204, 404))
                db.x("DELETE FROM events WHERE id=?", (e["id"],))
                continue
            body = _graph_event(e)
            if e["href"]:
                g.call("PATCH", f"/me/events/{e['href']}", js=body)
            else:
                j = g.call("POST", f"/me/calendars/{c['id']}/events", js=body)
                db.x("UPDATE events SET href=? WHERE id=?", (j["id"], e["id"]))
            db.x("UPDATE events SET dirty=0 WHERE id=?", (e["id"],))
        a = (datetime.now(timezone.utc) - timedelta(days=PAST)).strftime("%Y-%m-%dT%H:%M:%SZ")
        z = (datetime.now(timezone.utc) + timedelta(days=FUTURE)).strftime("%Y-%m-%dT%H:%M:%SZ")
        items = g.pages(f"/me/calendars/{c['id']}/calendarView?startDateTime={a}&endDateTime={z}&$top=500"
                        "&$select=id,subject,start,end,isAllDay,location,iCalUId,seriesMasterId,type", limit=5000)
        ids = set()
        for it in items:
            ids.add(it["id"])
            st_, en_ = _graph_time(it["start"]), _graph_time(it["end"])
            row = db.one("SELECT id, dirty FROM events WHERE cal_id=? AND href=?", (cid, it["id"]))
            if row and row["dirty"]:
                continue
            vals = (it.get("iCalUId") or it["id"], it.get("subject") or "", (it.get("location") or {}).get("displayName", ""), st_, en_,
                    int(bool(it.get("isAllDay"))), "occ" if it.get("seriesMasterId") else "")
            if row:
                db.x("UPDATE events SET uid=?, summary=?, location=?, start=?, end=?, allday=?, etag=? WHERE id=?", (*vals, row["id"]))
            else:
                db.x("INSERT INTO events(uid, summary, location, start, end, allday, etag, cal_id, href) VALUES(?,?,?,?,?,?,?,?,?)", (*vals, cid, it["id"]))
        for row in db.q("SELECT id, href FROM events WHERE cal_id=? AND dirty=0 AND href!=''", (cid,)):
            if row["href"] not in ids:
                db.x("DELETE FROM events WHERE id=?", (row["id"],))
    for r in db.q("SELECT id FROM calendars WHERE account=? AND kind='cal' AND href!='locale'", (acc["id"],)):
        if r["id"] not in seen:
            db.x("DELETE FROM events WHERE cal_id=?", (r["id"],))
            db.x("DELETE FROM calendars WHERE id=?", (r["id"],))
    # rubrica
    book = book_of(acc["id"], "graph", t("mail.contatti"))
    for c in db.q("SELECT * FROM contacts WHERE book_id=? AND dirty=1", (book,)):
        if c["deleted"]:
            if c["href"]:
                g.call("DELETE", f"/me/contacts/{c['href']}", ok=(204, 404))
            db.x("DELETE FROM contacts WHERE id=?", (c["id"],))
            continue
        v = vcard_parse(c["vcf"])
        body = {"displayName": v["name"], "givenName": v["name"].split(" ")[0], "surname": " ".join(v["name"].split(" ")[1:]),
                "emailAddresses": [{"address": e, "name": v["name"]} for e in v["emails"]], "businessPhones": v["phones"][:2], "companyName": v["org"]}
        if c["href"]:
            g.call("PATCH", f"/me/contacts/{c['href']}", js=body)
        else:
            j = g.call("POST", "/me/contacts", js=body)
            db.x("UPDATE contacts SET href=? WHERE id=?", (j["id"], c["id"]))
        db.x("UPDATE contacts SET dirty=0 WHERE id=?", (c["id"],))
    ids = set()
    for x in g.pages("/me/contacts?$top=500&$select=id,displayName,emailAddresses,businessPhones,mobilePhone,homePhones,companyName,jobTitle", limit=20000):
        ids.add(x["id"])
        row = db.one("SELECT id, dirty FROM contacts WHERE book_id=? AND href=?", (book, x["id"]))
        if row and row["dirty"]:
            continue
        vcf = vcard_build({"uid": x["id"], "name": x.get("displayName") or "", "emails": [e["address"].lower() for e in x.get("emailAddresses") or [] if e.get("address")],
                           "phones": (x.get("businessPhones") or []) + ([x["mobilePhone"]] if x.get("mobilePhone") else []) + (x.get("homePhones") or []),
                           "org": x.get("companyName") or "", "title": x.get("jobTitle") or ""})
        store_contact(book, vcf, x["id"], "", 0, row["id"] if row else None)
    for row in db.q("SELECT id, href FROM contacts WHERE book_id=? AND dirty=0 AND href!=''", (book,)):
        if row["href"] not in ids:
            db.x("DELETE FROM contacts WHERE id=?", (row["id"],))
    engine.bump()


def _graph_time(x) -> float:
    s = x["dateTime"]
    s = re.sub(r"\.(\d{6})\d*", r".\1", s)
    d = datetime.fromisoformat(s)
    tz = ical._tz(x.get("timeZone") or "UTC") or timezone.utc
    return d.replace(tzinfo=tz).timestamp()


def _graph_event(e) -> dict:
    ev = (ical.events(e["ics"]) or [{}])[0] if e["ics"] else {}
    fmt = lambda ts: datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")  # noqa: E731
    body = {"subject": e["summary"], "isAllDay": bool(e["allday"]), "start": {"dateTime": fmt(e["start"]), "timeZone": "UTC"},
            "end": {"dateTime": fmt(e["end"]), "timeZone": "UTC"}, "location": {"displayName": e["location"] or ""}}
    if ev.get("description"):
        body["body"] = {"contentType": "text", "content": ev["description"]}
    if ev.get("attendees"):
        body["attendees"] = [{"emailAddress": {"address": a["a"], "name": a.get("n", "")}, "type": "required"} for a in ev["attendees"]]
    return body


# ------------------------------------------------------------------ giro di sincronizzazione (chiamato da engine.Worker)
_LAST = {}


def sync_account(acc, force=False):
    if not force and time.time() - _LAST.get(acc["id"], 0) < 600:
        return
    _LAST[acc["id"]] = time.time()
    try:
        if acc.get("tipo") == "graph":
            sync_graph(acc)
        else:
            if acc.get("caldav"):
                sync_caldav(_google_urls(acc, "caldav"))
            if acc.get("carddav"):
                sync_carddav(_google_urls(acc, "carddav"))
    except MailError as e:
        engine.set_status(acc["id"], avviso_cal=str(e))


def _google_urls(acc, kind):
    """Google: principal CalDAV dell'utente e rubrica predefinita CardDAV."""
    if acc.get("oauth") != "google":
        return acc
    u = acc[kind]
    if kind == "caldav" and u.rstrip("/").endswith("caldav/v2"):
        u = f"{u.rstrip('/')}/{acc['email']}/user"
    if kind == "carddav" and u.rstrip("/").endswith("principals"):
        u = f"{u.rstrip('/')}/{acc['email']}/lists/default/"
    return {**acc, kind: u}


# ------------------------------------------------------------------ operazioni dell'interfaccia
def save_event_ui(b) -> dict:
    """Evento nuovo o modificato; con partecipanti parte l'invito (METHOD:REQUEST) dall'account del calendario."""
    db = engine.db()
    cal = db.one("SELECT * FROM calendars WHERE id=?", (int(b["cal"]),))
    if not cal or cal["readonly"]:
        raise MailError(t("srv_mail.calendario_sola_lettura"))
    acc = accounts.get(cal["account"])
    old = db.one("SELECT * FROM events WHERE id=?", (int(b["id"]),)) if b.get("id") else None
    oldev = (ical.events(old["ics"]) or [{}])[0] if old and old["ics"] else {}
    ev = {"uid": (old or {}).get("uid") or (uuid.uuid4().hex + "@mbvisual"), "summary": b.get("summary", ""), "location": b.get("location", ""),
          "description": b.get("description", ""), "start": float(b["start"]), "end": float(b["end"]), "allday": bool(b.get("allday")),
          "rrule": b.get("rrule", ""), "sequence": int(oldev.get("sequence") or 0) + (1 if old else 0),
          "attendees": [{"a": a["a"].lower(), "n": a.get("n", "")} for a in b.get("attendees") or [] if a.get("a")],
          "promemoria": [int(b["promemoria"])] if b.get("promemoria") not in (None, "", -1, "-1") else []}
    org = {"a": acc["email"], "n": acc.get("nome", "")} if ev["attendees"] else None
    ics = ical.make_event(ev, organizer=org)
    vals = (ev["uid"], ev["summary"], ev["location"], ev["start"], ev["end"], int(ev["allday"]), ev["rrule"], ics)
    if old:
        if old["cal_id"] != cal["id"]:  # spostato in un altro calendario: eliminato dal vecchio, nuovo nel nuovo
            db.x("UPDATE events SET deleted=1, dirty=1 WHERE id=?", (old["id"],))
            eid = db.x("INSERT INTO events(uid, summary, location, start, end, allday, rrule, ics, cal_id, dirty) VALUES(?,?,?,?,?,?,?,?,?,1)", (*vals, cal["id"]))
        else:
            db.x("UPDATE events SET uid=?, summary=?, location=?, start=?, end=?, allday=?, rrule=?, ics=?, dirty=1 WHERE id=?", (*vals, old["id"]))
            eid = old["id"]
    else:
        eid = db.x("INSERT INTO events(uid, summary, location, start, end, allday, rrule, ics, cal_id, dirty) VALUES(?,?,?,?,?,?,?,?,?,1)", (*vals, cal["id"]))
    if cal["href"] == "locale":
        db.x("UPDATE events SET dirty=0 WHERE id=?", (eid,))
    if ev["attendees"] and acc.get("tipo") != "graph" and b.get("invia", True):  # Graph manda da solo gli inviti ai partecipanti
        invite = ical.make_event(ev, method="REQUEST", organizer=org)
        subj = t("mail.invito_oggetto", ev["summary"])
        when = datetime.fromtimestamp(ev["start"]).strftime("%d/%m/%Y %H:%M")
        raw, info = compose.build({"to": ev["attendees"], "subject": subj, "text": f"{ev['summary']}\n{when}\n{ev['location']}\n\n{ev['description']}",
                                   "ics": [{"data": invite, "method": "REQUEST"}]}, acc)
        engine.queue_send(acc["id"], raw, info)
    engine.bump()
    engine.kick(acc["id"], "ops")
    _LAST.pop(acc["id"], None)
    return {"ok": True, "id": eid}


def delete_event_ui(b) -> dict:
    db = engine.db()
    e = db.one("SELECT e.*, c.account, c.href AS cal_href FROM events e JOIN calendars c ON c.id=e.cal_id WHERE e.id=?", (int(b["id"]),))
    if not e:
        return {"ok": True}
    ev = (ical.events(e["ics"]) or [{}])[0] if e["ics"] else {}
    acc = accounts.get(e["account"])
    if ev.get("attendees") and b.get("avvisa", True) and (ev.get("organizer") or {}).get("a") == acc["email"] and acc.get("tipo") != "graph":
        ev["sequence"] = int(ev.get("sequence") or 0) + 1
        cancel = ical.make_event(ev, method="CANCEL", organizer=ev.get("organizer"))
        raw, info = compose.build({"to": ev["attendees"], "subject": t("mail.annullato_oggetto", ev.get("summary", "")), "text": ev.get("summary", ""),
                                   "ics": [{"data": cancel, "method": "CANCEL"}]}, acc)
        engine.queue_send(acc["id"], raw, info)
    if e["cal_href"] == "locale":
        db.x("DELETE FROM events WHERE id=?", (e["id"],))
    else:
        db.x("UPDATE events SET deleted=1, dirty=1 WHERE id=?", (e["id"],))
    _LAST.pop(e["account"], None)
    engine.kick(e["account"], "ops")
    engine.bump()
    return {"ok": True}


def handle(op, q, b) -> dict:
    db = engine.db()
    if op == "contacts":
        rows = db.q("""SELECT c.id, c.name, c.emails, c.phones, c.org, c.book_id, k.name AS book, k.account FROM contacts c
                       LEFT JOIN calendars k ON k.id=c.book_id WHERE c.deleted=0 ORDER BY c.name COLLATE NOCASE""")
        for r in rows:
            r["emails"], r["phones"] = json.loads(r["emails"] or "[]"), json.loads(r["phones"] or "[]")
        books = db.q("SELECT id, account, name FROM calendars WHERE kind='book'")
        for a in accounts.all_accounts():
            if not any(x["account"] == a["id"] for x in books):
                books.append({"id": book_of(a["id"]), "account": a["id"], "name": t("mail.contatti")})
        if b.get("id"):
            c = db.one("SELECT * FROM contacts WHERE id=?", (int(b["id"]),))
            return {"ok": True, "contatto": c}
        return {"ok": True, "items": rows, "rubriche": books}
    if op == "contact_save":
        book = int(b.get("book") or 0)
        old = db.one("SELECT * FROM contacts WHERE id=?", (int(b["id"]),)) if b.get("id") else None
        vcf = vcard_build({**b, "uid": (old or {}).get("uid") or ""}, (old or {}).get("vcf", ""))
        bk = db.one("SELECT href FROM calendars WHERE id=?", (book or (old or {}).get("book_id"),))
        cid = store_contact(book or old["book_id"], vcf, (old or {}).get("href", ""), (old or {}).get("etag", ""),
                            0 if bk and bk["href"].startswith("locale") else 1, old["id"] if old else None)
        acc_r = db.one("SELECT account FROM calendars WHERE id=?", (book or old["book_id"],))
        if acc_r:
            _LAST.pop(acc_r["account"], None)
            engine.kick(acc_r["account"], "sync")
        engine.bump()
        return {"ok": True, "id": cid}
    if op == "contact_delete":
        c = db.one("SELECT c.*, k.href AS bh FROM contacts c LEFT JOIN calendars k ON k.id=c.book_id WHERE c.id=?", (int(b["id"]),))
        if c:
            if c["bh"] is None or c["bh"].startswith("locale") or not c["href"]:
                db.x("DELETE FROM contacts WHERE id=?", (c["id"],))
            else:
                db.x("UPDATE contacts SET deleted=1, dirty=1 WHERE id=?", (c["id"],))
        engine.bump()
        return {"ok": True}
    if op == "dav_discover":
        acc = accounts.get(b["account"])
        return {"ok": True, "calendari": discover(Dav(acc, b.get("url") or acc.get("caldav")), "cal")}
    raise MailError(t("srv_mail.operazione_sconosciuta"))


_ = urlparse
