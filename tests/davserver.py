"""Server CalDAV/CardDAV di prova (in memoria) per il collaudo di calendario e contatti della posta.

Struttura: /dav/ (current-user-principal) -> /dav/principals/u/ (calendar-home-set /dav/cal/, addressbook-home-set
/dav/card/) -> /dav/cal/lavoro/ (calendario), /dav/cal/attivita/ (solo VTODO, da ignorare), /dav/card/rubrica/.
Autenticazione Basic utente "mario" password "prova". PROPFIND (Depth 0/1), REPORT (tutto), GET, PUT (ETag,
If-Match, If-None-Match), DELETE.
"""
import base64
import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse


class Dav:
    cols = {"/dav/cal/lavoro/": {"tipo": "cal", "nome": "Lavoro", "colore": "#30A46C"},
            "/dav/cal/attivita/": {"tipo": "todo", "nome": "Attivita'"},
            "/dav/card/rubrica/": {"tipo": "book", "nome": "Rubrica dello studio"}}
    res = {}     # href -> (dati, etag)
    ctag = 1
    log = []


def etag(data: bytes) -> str:
    return '"' + hashlib.md5(data).hexdigest()[:12] + '"'


def put(href, data: bytes):
    Dav.res[href] = (data, etag(data))
    Dav.ctag += 1


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="application/xml; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        a = self.headers.get("Authorization", "")
        ok = a.startswith("Basic ") and base64.b64decode(a[6:]).decode() == "mario:prova"
        if not ok:
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                self.rfile.read(n)
            self._send(401, b"", extra={"WWW-Authenticate": 'Basic realm="dav"'})
        return ok

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _resp(self, href, props):
        return f"<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"

    def _ms(self, items):
        x = ('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" '
             'xmlns:a="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">' + "".join(items) + "</d:multistatus>")
        self._send(207, x.encode())

    def do_PROPFIND(self):
        if not self._auth():
            return
        self._body()
        p = unquote(urlparse(self.path).path)
        depth = self.headers.get("Depth", "0")
        Dav.log.append(("PROPFIND", p, depth))
        if p in ("/dav/", "/dav"):
            return self._ms([self._resp("/dav/", "<d:current-user-principal><d:href>/dav/principals/u/</d:href></d:current-user-principal>"
                                                 "<d:resourcetype><d:collection/></d:resourcetype>")])
        if p == "/dav/principals/u/":
            return self._ms([self._resp(p, "<c:calendar-home-set><d:href>/dav/cal/</d:href></c:calendar-home-set>"
                                           "<a:addressbook-home-set><d:href>/dav/card/</d:href></a:addressbook-home-set>")])
        if p in ("/dav/cal/", "/dav/card/"):
            items = [self._resp(p, "<d:resourcetype><d:collection/></d:resourcetype>")]
            if depth == "1":
                for h, c in Dav.cols.items():
                    if not h.startswith(p):
                        continue
                    if c["tipo"] == "book":
                        rt = "<d:collection/><a:addressbook/>"
                        extra = ""
                    else:
                        rt = "<d:collection/><c:calendar/>"
                        comp = "VEVENT" if c["tipo"] == "cal" else "VTODO"
                        extra = f'<c:supported-calendar-component-set><c:comp name="{comp}"/></c:supported-calendar-component-set>'
                    items.append(self._resp(h, f"<d:resourcetype>{rt}</d:resourcetype><d:displayname>{c['nome']}</d:displayname>"
                                               f"<cs:getctag>{Dav.ctag}</cs:getctag><ic:calendar-color>{c.get('colore', '')}FF</ic:calendar-color>"
                                               "<d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>" + extra))
            return self._ms(items)
        self._send(404)

    def do_REPORT(self):
        if not self._auth():
            return
        self._body()
        p = unquote(urlparse(self.path).path)
        Dav.log.append(("REPORT", p))
        tag = "c:calendar-data" if "/cal/" in p else "a:address-data"
        items = []
        for h, (data, et) in Dav.res.items():
            if h.startswith(p):
                txt = data.decode().replace("&", "&amp;").replace("<", "&lt;")
                items.append(self._resp(h, f"<d:getetag>{et}</d:getetag><{tag}>{txt}</{tag}>"))
        self._ms(items)

    def do_GET(self):
        if not self._auth():
            return
        p = unquote(urlparse(self.path).path)
        if p in Dav.res:
            return self._send(200, Dav.res[p][0], "text/calendar", {"ETag": Dav.res[p][1]})
        self._send(404)

    def do_PUT(self):
        if not self._auth():
            return
        p = unquote(urlparse(self.path).path)
        data = self._body()
        Dav.log.append(("PUT", p))
        cur = Dav.res.get(p)
        if self.headers.get("If-None-Match") == "*" and cur:
            return self._send(412)
        if self.headers.get("If-Match") and (not cur or cur[1] != self.headers["If-Match"]):
            return self._send(412)
        put(p, data)
        self._send(201 if not cur else 204, b"", extra={"ETag": Dav.res[p][1]})

    def do_DELETE(self):
        if not self._auth():
            return
        p = unquote(urlparse(self.path).path)
        Dav.log.append(("DELETE", p))
        if Dav.res.pop(p, None):
            Dav.ctag += 1
            return self._send(204)
        self._send(404)


def start():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}", srv


def seed():
    put("/dav/cal/lavoro/riunione.ics", ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Prova//IT\r\nBEGIN:VEVENT\r\nUID:riunione-settimanale@prova\r\n"
                                         "DTSTAMP:20261001T080000Z\r\nDTSTART;TZID=Europe/Rome:20261005T090000\r\nDTEND;TZID=Europe/Rome:20261005T100000\r\n"
                                         "RRULE:FREQ=WEEKLY;BYDAY=MO\r\nSUMMARY:Riunione di studio\r\nLOCATION:Sala riunioni\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").encode())
    put("/dav/cal/lavoro/consegna.ics", ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Prova//IT\r\nBEGIN:VEVENT\r\nUID:consegna-24017@prova\r\n"
                                         "DTSTAMP:20261001T080000Z\r\nDTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261031\r\n"
                                         "SUMMARY:Consegna progetto 24-017\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").encode())
    put("/dav/card/rubrica/anna.vcf", ("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:anna-bianchi\r\nFN:Anna Bianchi\r\nN:Bianchi;Anna;;;\r\n"
                                       "ORG:Cliente S.r.l.\r\nEMAIL;TYPE=INTERNET:anna@cliente.prova.it\r\nTEL;TYPE=CELL:+39 333 1234567\r\n"
                                       "X-PROGETTO:24-017\r\nEND:VCARD\r\n").encode())
