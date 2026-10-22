"""Collaudo di Microsoft 365 (Graph) e Gmail con OAuth senza account veri: finto fornitore OAuth, finto Microsoft Graph
per la posta e server IMAP/SMTP di prova (tests/mailserver.py) con XOAUTH2 al posto di Gmail.

    python tests/test_mail_oauth.py
"""
import base64
import email
import email.policy
import json
import os
import re
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="mbv-posta-oauth-"))
os.environ["MBV_MAIL_DIR"] = str(TMP / "posta")
os.environ["MBV_CLOUD_DIR"] = str(TMP / "cloud")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import mailserver  # noqa: E402
from mbvisual import cloud, jobs  # noqa: E402
from mbvisual.mail import accounts, api, engine, graphmail, oauth  # noqa: E402

engine.NO_THREADS[0] = True
OK, FAIL = 0, []


def check(name, cond, info=""):
    global OK
    if cond:
        OK += 1
        print("  ok  ", name)
    else:
        FAIL.append(name)
        print("  NO  ", name, info)


# ------------------------------------------------------------------ finto Microsoft Graph (posta)
def mime(frm, to, subj, text, date_off=0, att=None):
    m = email.message.EmailMessage()
    m["From"], m["To"], m["Subject"] = frm, to, subj
    m["Date"] = email.utils.formatdate(time.time() - date_off, localtime=True)
    m["Message-ID"] = email.utils.make_msgid(domain="graph.prova")
    m.set_content(text)
    if att:
        m.add_attachment(att[1], maintype="application", subtype="octet-stream", filename=att[0])
    return m.as_bytes()


class G:
    folders = {}   # id -> {name, parent, wk}
    msgs = {}      # id -> {folder, raw, isRead, flag, categories, ver}
    ver = 0
    sent = []
    tokens_seen = []

    @classmethod
    def reset(cls):
        cls.folders = {"F-in": {"name": "Posta in arrivo", "parent": None, "wk": "inbox"}, "F-sent": {"name": "Posta inviata", "parent": None, "wk": "sentitems"},
                       "F-dr": {"name": "Bozze", "parent": None, "wk": "drafts"}, "F-del": {"name": "Posta eliminata", "parent": None, "wk": "deleteditems"},
                       "F-junk": {"name": "Posta indesiderata", "parent": None, "wk": "junkemail"}, "F-arch": {"name": "Archivio", "parent": None, "wk": "archive"},
                       "F-prog": {"name": "Progetti", "parent": None, "wk": None}, "F-sub": {"name": "Cantiere Nord", "parent": "F-prog", "wk": None}}
        cls.msgs = {}
        cls.add("F-in", mime("Ufficio tecnico <ut@comune.prova>", "ing@studio365.prova", "Parere commessa 25-003", "Parere favorevole.", 3600,
                             ("parere.pdf", b"%PDF-1.4 prova")))
        cls.add("F-in", mime("Cliente <c@cliente.prova>", "ing@studio365.prova", "Sopralluogo", "Ci vediamo giovedi'.", 7200))
        cls.add("F-sub", mime("Impresa <i@impresa.prova>", "ing@studio365.prova", "SAL 3", "In allegato il SAL.", 86400))

    @classmethod
    def add(cls, folder, raw, read=False):
        cls.ver += 1
        mid = "M" + uuid.uuid4().hex[:10]
        cls.msgs[mid] = {"folder": folder, "raw": raw, "isRead": read, "flag": "notFlagged", "categories": [], "ver": cls.ver}
        return mid

    @classmethod
    def json_of(cls, mid):
        x = cls.msgs[mid]
        m = email.message_from_bytes(x["raw"], policy=email.policy.default)
        ad = lambda v: [{"emailAddress": {"name": n, "address": a}} for n, a in email.utils.getaddresses([str(v)])] if v else []  # noqa: E731
        return {"id": mid, "subject": str(m["Subject"] or ""), "from": (ad(m["From"]) or [None])[0], "toRecipients": ad(m["To"]), "ccRecipients": [],
                "receivedDateTime": email.utils.parsedate_to_datetime(str(m["Date"])).isoformat(), "isRead": x["isRead"],
                "flag": {"flagStatus": x["flag"]}, "hasAttachments": m.is_multipart(), "internetMessageId": str(m["Message-ID"]),
                "bodyPreview": "anteprima", "categories": x["categories"], "importance": "normal", "parentFolderId": x["folder"], "isDraft": x["folder"] == "F-dr"}


class GH(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, raw=None, ctype="application/json"):
        b = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b"")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _auth(self):
        tok = (self.headers.get("Authorization") or "")[7:]
        G.tokens_seen.append(tok)
        if not tok.startswith("token-"):
            self._send(401, {"error": {"code": "InvalidAuthenticationToken", "message": "token"}})
            return False
        return True

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/oauth/token":
            f = {k: v[0] for k, v in parse_qs(self._body().decode()).items()}
            if f["grant_type"] == "authorization_code" and f.get("code") == "codice-ok" and f.get("code_verifier"):
                return self._send(200, {"access_token": "token-prova", "refresh_token": "rinnovo-1", "expires_in": 3600})
            if f["grant_type"] == "refresh_token" and f.get("refresh_token", "").startswith("rinnovo-"):
                return self._send(200, {"access_token": "token-prova", "refresh_token": "rinnovo-2", "expires_in": 3600})
            return self._send(400, {"error": "invalid_grant"})
        if not self._auth():
            return
        p = u.path.replace("/v1.0", "")
        body = self._body()
        m = re.match(r"/me/calendars/([^/]+)/events$", p)
        if m:
            b = json.loads(body)
            eid = "E" + uuid.uuid4().hex[:6]
            G.events[eid] = {**b, "id": eid, "iCalUId": "ical-" + eid}
            return self._send(201, G.events[eid])
        m = re.match(r"/me/events/([^/]+)/(accept|tentativelyAccept|decline)$", p)
        if m:
            G.responses.append((m.group(1), m.group(2), json.loads(body).get("sendResponse")))
            return self._send(202)
        if p == "/me/contacts":
            b = json.loads(body)
            cid = "P" + uuid.uuid4().hex[:6]
            G.contacts[cid] = {**b, "id": cid}
            return self._send(201, G.contacts[cid])
        if p == "/me/sendMail":
            raw = base64.b64decode(body)
            G.sent.append(raw)
            G.add("F-sent", raw, True)
            return self._send(202)
        if p == "/me/messages":
            raw = base64.b64decode(body) if self.headers.get("Content-Type", "").startswith("text/plain") else mime("ing@studio365.prova", "", "bozza", "x")
            mid = G.add("F-dr", raw, True)
            return self._send(201, G.json_of(mid))
        m = re.match(r"/me/messages/([^/]+)/move$", p)
        if m:
            x = G.msgs.pop(m.group(1))
            G.ver += 1
            nid = "M" + uuid.uuid4().hex[:10]
            G.msgs[nid] = {**x, "folder": json.loads(body)["destinationId"], "ver": G.ver}
            return self._send(201, G.json_of(nid))
        m = re.match(r"/me/mailFolders(?:/([^/]+)/childFolders)?$", p)
        if m:
            fid = "F" + uuid.uuid4().hex[:6]
            G.folders[fid] = {"name": json.loads(body)["displayName"], "parent": m.group(1), "wk": None}
            return self._send(201, {"id": fid})
        self._send(404, {"error": {"message": "non trovato " + p}})

    def do_PATCH(self):
        if not self._auth():
            return
        p = urlparse(self.path).path.replace("/v1.0", "")
        b = json.loads(self._body())
        m = re.match(r"/me/(events|contacts)/([^/]+)$", p)
        if m:
            store = G.events if m.group(1) == "events" else G.contacts
            store[m.group(2)].update(b)
            return self._send(200, store[m.group(2)])
        m = re.match(r"/me/messages/([^/]+)$", p)
        x = G.msgs[m.group(1)]
        if "isRead" in b:
            x["isRead"] = b["isRead"]
        if "flag" in b:
            x["flag"] = b["flag"]["flagStatus"]
        if "categories" in b:
            x["categories"] = b["categories"]
        G.ver += 1
        x["ver"] = G.ver
        self._send(200, G.json_of(m.group(1)))

    def do_DELETE(self):
        if not self._auth():
            return
        p = urlparse(self.path).path.replace("/v1.0", "")
        m = re.match(r"/me/(events|contacts)/([^/]+)$", p)
        if m:
            (G.events if m.group(1) == "events" else G.contacts).pop(m.group(2), None)
            return self._send(204)
        m = re.match(r"/me/messages/([^/]+)$", p)
        if m and m.group(1) in G.msgs:
            G.msgs.pop(m.group(1))
            G.removed.append(m.group(1))
            return self._send(204)
        self._send(404)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/userinfo":
            return self._send(200, {"email": "studio.gmail@prova.it", "name": "Studio Gmail"})
        if not self._auth():
            return
        p = u.path.replace("/v1.0", "")
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if p == "/me":
            return self._send(200, {"mail": "ing@studio365.prova", "displayName": "Ing. Studio 365"})
        if p == "/me/calendars":
            return self._send(200, {"value": [{"id": "C1", "name": "Calendario", "hexColor": "#d6559a", "canEdit": True}]})
        if p == "/me/calendars/C1/calendarView":
            return self._send(200, {"value": list(G.events.values())})
        if p == "/me/events":
            uid = re.search(r"iCalUId eq '([^']*)'", q.get("$filter", ""))
            return self._send(200, {"value": [{"id": e["id"]} for e in G.events.values() if uid and e.get("iCalUId") == uid.group(1)]})
        if p == "/me/contacts":
            return self._send(200, {"value": list(G.contacts.values())})
        m = re.match(r"/me/mailFolders/([^/]+)$", p)
        if m:
            fid = next((k for k, v in G.folders.items() if v["wk"] == m.group(1)), m.group(1))
            if fid not in G.folders:
                return self._send(404, {"error": {"message": "no"}})
            return self._send(200, {"id": fid, "unreadItemCount": 1})
        if p == "/me/mailFolders" or re.match(r"/me/mailFolders/[^/]+/childFolders$", p):
            parent = p.split("/")[3] if "childFolders" in p else None
            out = [{"id": k, "displayName": v["name"], "childFolderCount": sum(1 for x in G.folders.values() if x["parent"] == k)}
                   for k, v in G.folders.items() if v["parent"] == parent]
            return self._send(200, {"value": out})
        m = re.match(r"/me/mailFolders/([^/]+)/messages/delta$", p) or re.match(r"/delta/([^/]+)$", p)
        if m:
            fid, since = m.group(1), int(q.get("dal", 0))
            out = [G.json_of(k) for k, v in G.msgs.items() if v["folder"] == fid and v["ver"] > since]
            out += [{"id": r, "@removed": {"reason": "deleted"}} for r in G.removed if since]
            return self._send(200, {"value": out, "@odata.deltaLink": f"{BASE}/v1.0/delta/{fid}?dal={G.ver}"})
        m = re.match(r"/me/messages/([^/]+)/\$value$", p)
        if m:
            return self._send(200, raw=G.msgs[m.group(1)]["raw"], ctype="message/rfc822")
        self._send(404, {"error": {"message": "non trovato " + p}})


G.removed = []
G.events = {"E1": {"id": "E1", "subject": "Riunione 365", "iCalUId": "ical-365", "start": {"dateTime": "2026-11-04T09:00:00.0000000", "timeZone": "UTC"},
                   "end": {"dateTime": "2026-11-04T10:00:00.0000000", "timeZone": "UTC"}, "isAllDay": False, "location": {"displayName": "Teams"}}}
G.contacts = {"P1": {"id": "P1", "displayName": "Paolo Neri", "emailAddresses": [{"address": "paolo@neri.prova"}], "businessPhones": ["02 1234"], "companyName": "Neri SpA"}}
G.responses = []
G.reset()
gsrv = ThreadingHTTPServer(("127.0.0.1", 0), GH)
gsrv.daemon_threads = True
threading.Thread(target=gsrv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{gsrv.server_address[1]}"
for k in ("microsoft", "google"):
    oauth.PROV[k]["auth"] = BASE + "/oauth/authorize"
    oauth.PROV[k]["token"] = BASE + "/oauth/token"
oauth.PROV["microsoft"]["me"] = BASE + "/v1.0/me"
oauth.PROV["google"]["me"] = BASE + "/userinfo"
graphmail.GraphProvider.API = BASE + "/v1.0"


def free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


cloud.set_config({"servizi": {"onedrive": {"client_id": "id-ms"}, "gdrive": {"client_id": "id-g", "client_secret": "segreto-g"}}, "porta": free_port()})


def browser(url, code="codice-ok"):
    """Il "browser": dalla pagina di accesso torna all'indirizzo di ritorno con codice e stato."""
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    sep = "&" if "?" in q["redirect_uri"] else "?"
    with urlopen(f"{q['redirect_uri']}{sep}code={code}&state={q['state']}", timeout=10) as r:
        r.read()
    return q


def wait(job):
    for _ in range(200):
        j = jobs.get(job)
        if j["status"] == "done":
            return j["result"]
        if j["status"] == "error":
            raise RuntimeError(j["error"])
        time.sleep(0.05)
    raise RuntimeError("tempo scaduto")


print("Accesso Microsoft 365 (OAuth + PKCE)")
check("ID applicazione presi dagli archivi cloud", oauth.status()["configurati"] == {"microsoft": True, "google": True})
r = oauth.login_start({"provider": "microsoft", "email": "ing@studio365.prova"}, open_browser=False)
q = browser(r["url"])
check("richiesta con PKCE, ambiti della posta e login_hint", q.get("code_challenge_method") == "S256" and "Mail.ReadWrite" in q["scope"]
      and "Calendars.ReadWrite" in q["scope"] and q.get("login_hint") == "ing@studio365.prova" and q["redirect_uri"].startswith("http://localhost:"))
res = wait(r["job"])
M = res["id"]
acc = accounts.get(M)
check("account Graph creato", acc["tipo"] == "graph" and acc["oauth"] == "microsoft" and acc["email"] == "ing@studio365.prova")
check("token cifrato nei segreti", accounts.secret(M)["oauth"]["refresh_token"] == "rinnovo-1" and b"rinnovo" not in accounts.SEC_FILE.read_bytes())

print("Sincronizzazione Graph")
st = engine.run_once(M)
check("sincronizzazione riuscita", st.get("stato") == "ok", st)
fs = {f["path"]: f for f in engine.db().q("SELECT * FROM folders WHERE account=?", (M,))}
check("cartelle e sottocartelle con i ruoli", fs["Posta in arrivo"]["role"] == "inbox" and fs["Posta inviata"]["role"] == "sent"
      and "Progetti/Cantiere Nord" in fs and fs["Archivio"]["role"] == "archive", list(fs))
inbox = fs["Posta in arrivo"]
rows = engine.db().q("SELECT * FROM messages WHERE folder_id=? ORDER BY date DESC", (inbox["id"],))
check("messaggi della posta in arrivo", len(rows) == 2 and rows[0]["subject"] == "Parere commessa 25-003")
check("MIME scaricato (lettura senza rete)", all(r["blob"] for r in rows) and rows[0]["has_att"] == 1)
m = api.message({"id": rows[0]["id"]})
check("lettura con allegato", any(a["nome"] == "parere.pdf" for a in m["atts"]))

print("Operazioni Graph")
engine.set_flags([rows[0]["id"]], seen=1, flagged=1)
engine.set_flags([rows[0]["id"]], categories=["Rosso"])
engine.run_once(M, "ops")
gm = next(v for v in G.msgs.values() if b"Parere commessa" in v["raw"])
check("letto, bandierina e categoria su Graph", gm["isRead"] and gm["flag"] == "flagged" and gm["categories"] == ["Rosso"], gm)
gm["isRead"] = False
G.ver += 1
gm["ver"] = G.ver
engine.run_once(M, "sync")
check("modifica fatta altrove arriva con il delta", engine.db().one("SELECT seen FROM messages WHERE id=?", (rows[0]["id"],))["seen"] == 0)
engine.move([rows[1]["id"]], fs["Archivio"]["id"])
engine.run_once(M, "sync")
arch = engine.db().q("SELECT * FROM messages WHERE folder_id=?", (fs["Archivio"]["id"],))
check("spostamento (nuovo id di Graph, niente doppioni)", len(arch) == 1 and any(v["folder"] == "F-arch" for v in G.msgs.values())
      and engine.db().one("SELECT COUNT(*) n FROM messages WHERE account=?", (M,))["n"] == 3)
api.send({"c": {"account": M, "to": [{"n": "", "a": "ut@comune.prova"}], "subject": "Risposta parere", "html": "<p>Grazie.</p>",
                "atts": []}})
engine.run_once(M, "ops")
check("invio con /me/sendMail (MIME)", any(b"Risposta parere" in x for x in G.sent))
engine.run_once(M, "sync")
check("copia in Posta inviata da Graph", engine.db().one("SELECT COUNT(*) n FROM messages WHERE folder_id=? AND subject='Risposta parere'", (fs["Posta inviata"]["id"],))["n"] == 1)
d = api.save_draft({"c": {"account": M, "to": [], "subject": "Bozza Graph", "html": "<p>x</p>"}})
engine.run_once(M, "ops")
check("bozza caricata in Bozze", any(v["folder"] == "F-dr" and b"Bozza Graph" in v["raw"] for v in G.msgs.values()))
engine.delete([arch[0]["id"]], permanent=True)
engine.run_once(M, "ops")
check("eliminazione definitiva", not any(v["folder"] == "F-arch" for v in G.msgs.values()))
api.handle("folder_create", {}, {"account": M, "parent": fs["Progetti"]["id"], "name": "Commessa 25-003"})
engine.run_once(M, "ops")
check("nuova cartella su Graph", any(v["name"] == "Commessa 25-003" and v["parent"] == "F-prog" for v in G.folders.values()))

print("Calendario e contatti Microsoft 365")
from mbvisual.mail import calapi, calsync  # noqa: E402
calsync.sync_account(accounts.get(M), force=True)
cal = engine.db().one("SELECT * FROM calendars WHERE account=? AND kind='cal'", (M,))
ev = engine.db().one("SELECT * FROM events WHERE cal_id=?", (cal["id"],))
check("calendario e eventi da Graph", cal["name"] == "Calendario" and ev and ev["summary"] == "Riunione 365" and ev["end"] - ev["start"] == 3600)
s0 = time.time() + 86400
calsync.save_event_ui({"cal": cal["id"], "summary": "Nuovo da MB Visual", "start": s0, "end": s0 + 1800, "attendees": [{"a": "x@y.it"}]})
calsync.sync_account(accounts.get(M), force=True)
ne = [e for e in G.events.values() if e.get("subject") == "Nuovo da MB Visual"]
check("evento creato su Graph (inviti spediti da Exchange)", ne and ne[0]["attendees"][0]["emailAddress"]["address"] == "x@y.it"
      and not engine.db().one("SELECT COUNT(*) n FROM outbox WHERE account=?", (M,))["n"])
ct = {c["name"]: c for c in calsync.handle("contacts", {}, {})["items"]}
check("contatti da Graph", "Paolo Neri" in ct and ct["Paolo Neri"]["emails"] == ["paolo@neri.prova"])
calsync.handle("contact_save", {}, {"book": ct["Paolo Neri"]["book_id"], "name": "Sara Blu", "emails": ["sara@blu.prova"]})
calsync.sync_account(accounts.get(M), force=True)
check("contatto creato su Graph", any(c.get("displayName") == "Sara Blu" for c in G.contacts.values()))
ics = ("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:ical-365\r\nDTSTART:20261104T090000Z\r\nDTEND:20261104T100000Z\r\n"
       "SUMMARY:Riunione 365\r\nORGANIZER:mailto:capo@altro.prova\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
msg = email.message_from_bytes(mime("Capo <capo@altro.prova>", "ing@studio365.prova", "Invito: Riunione 365", "invito"), policy=email.policy.default)
msg.add_attachment(ics.encode(), maintype="text", subtype="calendar", filename="invito.ics")
mid = engine.add_message(M, inbox["id"], msg.as_bytes(), local=True)
pi = api.message({"id": mid})["inviti"][0]["i"]
calapi.cal_reply({"id": mid, "i": pi, "risposta": "TENTATIVE"})
check("risposta all'invito con l'API di Exchange", G.responses == [("E1", "tentativelyAccept", True)], G.responses)

print("Rinnovo del token")
tok = accounts.secret(M)["oauth"]
tok["expires_at"] = time.time() - 10
tok["access_token"] = "scaduto"
accounts.set_secret(M, oauth=tok)
check("token scaduto rinnovato con il refresh token", oauth.access_token(accounts.get(M)) == "token-prova"
      and accounts.secret(M)["oauth"]["refresh_token"] == "rinnovo-2")
tok = accounts.secret(M)["oauth"]
tok.update(expires_at=0, refresh_token="revocato")
accounts.set_secret(M, oauth=tok)
st = engine.run_once(M, "sync")
check("refresh token revocato: chiede un nuovo accesso", st.get("stato") == "errore" and st.get("auth"), st)

print("Gmail con OAuth (IMAP e SMTP XOAUTH2)")
mailserver.seed()
ip, sp, _ = mailserver.start()
r = oauth.login_start({"provider": "google", "email": "mario@studio.prova.it"}, open_browser=False)
q = browser(r["url"])
check("Google: offline + consent, ritorno su 127.0.0.1", q.get("access_type") == "offline" and q.get("prompt") == "consent"
      and q["redirect_uri"].startswith("http://127.0.0.1:") and "https://mail.google.com/" in q["scope"])
res = wait(r["job"])
Gm = res["id"]
a = accounts.get(Gm)
check("account Gmail: IMAP/SMTP con OAuth", a["imap"] == "imap.gmail.com" and a["oauth"] == "google" and a["salva_inviati"] is False)
# il server di prova fa da Gmail (stesso token)
accounts.save_account({"id": Gm, "email": "mario@studio.prova.it", "utente": "mario@studio.prova.it", "imap": "127.0.0.1", "imap_port": ip,
                       "imap_sec": "none", "smtp": "127.0.0.1", "smtp_port": sp, "smtp_sec": "none"})
st = engine.run_once(Gm)
check("sincronizzazione IMAP con XOAUTH2", st.get("stato") == "ok" and engine.db().one("SELECT COUNT(*) n FROM messages WHERE account=?", (Gm,))["n"] >= 30, st)
api.send({"c": {"account": Gm, "to": [{"n": "", "a": "anna@cliente.prova.it"}], "subject": "Inviato con XOAUTH2", "html": "<p>ok</p>"}})
engine.run_once(Gm, "ops")
check("invio SMTP con XOAUTH2", any(b"Inviato con XOAUTH2" in x["raw"] for x in mailserver.BOX.users["anna@cliente.prova.it"]["folders"]["INBOX"]["msgs"]))
check("niente APPEND in Inviata (Gmail la salva da solo)",
      not any(b"Inviato con XOAUTH2" in x["raw"] for x in mailserver.BOX.users["mario@studio.prova.it"]["folders"]["Inviata"]["msgs"]))
r = oauth.login_start({"provider": "google", "email": "x@y.it"}, open_browser=False)
browser(r["url"], code="sbagliato")
try:
    wait(r["job"])
    check("codice rifiutato -> errore leggibile", False)
except RuntimeError as e:
    check("codice rifiutato -> errore leggibile", "Google" in str(e), str(e))

print(f"\n{OK} prove riuscite, {len(FAIL)} fallite" + (": " + ", ".join(FAIL) if FAIL else ""))
sys.exit(1 if FAIL else 0)
