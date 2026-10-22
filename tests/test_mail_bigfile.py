"""Collaudo degli invii grandi come link (mbvisual/mail/bigfile.py) con un finto OneDrive (Microsoft Graph) e un finto
Dropbox, e della conferma di lettura (MDN).

    python tests/test_mail_bigfile.py
"""
import json
import os
import re
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="mbv-posta-link-"))
os.environ["MBV_MAIL_DIR"] = str(TMP / "posta")
os.environ["MBV_CLOUD_DIR"] = str(TMP / "cloud")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import mailserver  # noqa: E402
from mbvisual import cloud  # noqa: E402
from mbvisual.mail import accounts, api, bigfile, engine  # noqa: E402

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


class F:
    items = {}
    folder = None
    links = []
    anon_ok = True
    dbx = {}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj=None):
        b = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        p = unquote(urlparse(self.path).path)
        if p == "/v1.0/me/drive":
            return self._send(200, {"id": "D1"})
        if p == "/v1.0/drives/D1/root:/MB Visual - Invii":
            return self._send(200, {"id": F.folder}) if F.folder else self._send(404, {"error": {"message": "no"}})
        m = re.match(r"/v1.0/drives/D1/items/([^/]+)$", p)
        if m and m.group(1) in F.items:
            x = F.items[m.group(1)]
            return self._send(200, {"id": m.group(1), "name": x["name"], "size": len(x["data"]), "lastModifiedDateTime": "2026-10-22T10:00:00Z",
                                    "parentReference": {"driveId": "D1", "id": F.folder}, "cTag": "c1", "file": {}})
        self._send(404, {"error": {"message": p}})

    def do_PUT(self):
        p = unquote(urlparse(self.path).path)
        m = re.match(r"/v1.0/drives/D1/items/([^/]+):/(.+):/content$", p)
        if m:
            iid = "I%d" % (len(F.items) + 1)
            F.items[iid] = {"name": m.group(2), "data": self._body()}
            return self._send(201, {"id": iid})
        self._send(404)

    def do_POST(self):
        p = unquote(urlparse(self.path).path)
        body = self._body()
        if p == "/v1.0/drives/D1/root/children":
            F.folder = "FOLD"
            return self._send(201, {"id": "FOLD"})
        m = re.match(r"/v1.0/drives/D1/items/([^/]+)/createLink$", p)
        if m:
            b = json.loads(body)
            if b["scope"] == "anonymous" and not F.anon_ok:
                return self._send(403, {"error": {"message": "anonymous links disabled"}})
            F.links.append(b)
            return self._send(201, {"link": {"webUrl": f"https://onedrive.prova/{m.group(1)}?{b['scope']}"}})
        if p == "/2/files/create_folder_v2":
            return self._send(409, {"error_summary": "path/conflict/folder"})
        if p == "/2/files/upload":
            arg = json.loads(self.headers["Dropbox-API-Arg"])
            F.dbx[arg["path"].lower()] = body
            return self._send(200, {"path_lower": arg["path"].lower(), "name": arg["path"].split("/")[-1], ".tag": "file", "size": len(body)})
        if p == "/2/files/get_metadata":
            b = json.loads(body)
            return self._send(200, {"path_lower": b["path"], "name": b["path"].split("/")[-1], ".tag": "file", "size": len(F.dbx.get(b["path"], b"")),
                                    "rev": "r1", "server_modified": "2026-10-22T10:00:00Z"})
        if p == "/2/sharing/create_shared_link_with_settings":
            return self._send(200, {"url": "https://dropbox.prova/s/" + json.loads(body)["path"].split("/")[-1]})
        self._send(404, {"error": {"message": p}})


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
srv.daemon_threads = True
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}"
cloud.PROVIDERS["onedrive"].API = BASE + "/v1.0"
cloud.PROVIDERS["dropbox"].API = BASE + "/2"
cloud.PROVIDERS["dropbox"].CONTENT = BASE + "/2"
cloud.set_config({"servizi": {"onedrive": {"client_id": "id-ms"}, "dropbox": {"client_id": "id-d"}}})
cloud._save_tokens({"onedrive": {"access_token": "t", "refresh_token": "r", "expires_at": time.time() + 3600},
                    "dropbox": {"access_token": "t", "refresh_token": "r", "expires_at": time.time() + 3600}})
big = TMP / "Tavole esecutive.zip"
big.write_bytes(os.urandom(300_000))

print("Invii grandi come link")
sv = bigfile.services()["servizi"]
check("servizi collegati del pannello Cloud", {s["id"] for s in sv if s["connesso"]} == {"onedrive", "dropbox"}, sv)
r = bigfile.upload(str(big), "onedrive", lambda *a: None)
check("caricato in OneDrive nella cartella 'MB Visual - Invii'", F.folder == "FOLD" and any(x["name"].endswith("Tavole esecutive.zip") for x in F.items.values()))
check("link anonimo con scadenza", r["url"].endswith("?anonymous") and "expirationDateTime" in F.links[-1] and r["scade"], (r, F.links))
F.anon_ok = False
r = bigfile.upload(str(big), "onedrive", lambda *a: None)
check("organizzazione senza link anonimi: link per l'organizzazione", r["url"].endswith("?organization"), r)
r = bigfile.upload(str(big), "dropbox", lambda *a: None)
check("Dropbox: cartella esistente, link condiviso", r["url"].startswith("https://dropbox.prova/s/") and any(k.startswith("/mb visual - invii/") for k in F.dbx), r)

print("Conferma di lettura")
mailserver.BOX.deliver("mario@studio.prova.it", b"From: Anna <anna@cliente.prova.it>\r\nTo: mario@studio.prova.it\r\nSubject: Verbale da firmare\r\n"
                                               b"Message-ID: <verbale@prova.it>\r\nDisposition-Notification-To: anna@cliente.prova.it\r\n"
                                               b"Date: Thu, 22 Oct 2026 10:00:00 +0200\r\n\r\nTi chiedo conferma di lettura.\r\n")
ip, sp, _ = mailserver.start()
A = accounts.save_account({"email": "mario@studio.prova.it", "imap": "127.0.0.1", "imap_port": ip, "imap_sec": "none", "smtp": "127.0.0.1",
                           "smtp_port": sp, "smtp_sec": "none", "password": "prova"})["id"]
engine.run_once(A)
row = engine.db().one("SELECT id FROM messages WHERE msgid='<verbale@prova.it>'")
m = api.message({"id": row["id"]})
check("richiesta di conferma riconosciuta", m["h"]["notify"] == "anna@cliente.prova.it" and not m["mdn_inviata"])
api.send_mdn({"id": row["id"]})
engine.run_once(A, "ops")
got = [x for x in mailserver.BOX.users["anna@cliente.prova.it"]["folders"]["INBOX"]["msgs"] if b"disposition-notification" in x["raw"]]
check("MDN (multipart/report) consegnata", got and b"Original-Message-ID: <verbale@prova.it>" in got[0]["raw"])
check("non la richiede piu'", api.message({"id": row["id"]})["mdn_inviata"])

print(f"\n{OK} prove riuscite, {len(FAIL)} fallite" + (": " + ", ".join(FAIL) if FAIL else ""))
sys.exit(1 if FAIL else 0)
