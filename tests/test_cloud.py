"""Collaudo locale degli archivi cloud (mbvisual/cloud.py) SENZA account reali: un finto fornitore OAuth e finte API
Dropbox e Microsoft Graph su 127.0.0.1. Prova: PKCE e ritorno su localhost (anche errori: negato, stato sbagliato,
porta occupata, tempo scaduto), token cifrati DPAPI, rinnovo e revoca del token, elenco/ricerca, apertura,
caricamento dei salvataggi, conflitti di versione, copia, "Salva nel cloud", errori di rete.
Il collegamento con i servizi veri si prova solo dopo la registrazione delle app (ui/guide/archivi-cloud.md).

    python tests/test_cloud.py
"""
import base64
import hashlib
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

TMP = Path(tempfile.mkdtemp(prefix="mbv-cloud-test-"))
os.environ["MBV_CLOUD_DIR"] = str(TMP / "dati")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mbvisual import cloud  # noqa: E402

cloud.CACHE = TMP / "cache"
cloud._ENTRIES_FILE = cloud.CACHE / "aperti.json"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ------------------------------------------------------------------ finto fornitore
class Fake:
    challenges = {}      # code -> (challenge, redirect)
    access = {"tok-1"}
    refresh_ok = True
    files = {}           # dropbox: path -> {"data", "rev"}
    graph = {}           # graph: id -> {"name", "data", "ctag", "parent"}
    calls = []


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _auth(self):
        tok = (self.headers.get("Authorization") or "")[7:]
        if tok not in Fake.access:
            self._send(401, {"error": {"code": "InvalidAuthenticationToken", "message": "scaduto"}})
            return False
        return True

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def route(self, m):
        u = urlparse(self.path)
        Fake.calls.append((m, u.path))
        body = self._body()
        # ---- token (Dropbox e Microsoft)
        if u.path.endswith("/token"):
            f = {k: v[0] for k, v in parse_qs(body.decode()).items()}
            if f["grant_type"] == "authorization_code":
                ch, red = Fake.challenges.get(f.get("code"), (None, None))
                calc = base64.urlsafe_b64encode(hashlib.sha256(f.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
                if ch is None or calc != ch or f.get("redirect_uri") != red or f.get("client_id") != "id-prova":
                    return self._send(400, {"error": "invalid_grant", "error_description": "PKCE o redirect non validi"})
                return self._send(200, {"access_token": "tok-1", "refresh_token": "rt-1", "expires_in": 3600})
            if f["grant_type"] == "refresh_token":
                if not Fake.refresh_ok or f.get("refresh_token") not in ("rt-1", "rt-2"):
                    return self._send(400, {"error": "invalid_grant"})
                Fake.access.add("tok-2")
                return self._send(200, {"access_token": "tok-2", "refresh_token": "rt-2", "expires_in": 3600})
        if u.path.startswith("/dl/"):  # downloadUrl di Graph (senza autorizzazione)
            return self._send(200, Fake.graph[u.path[4:]]["data"], "application/octet-stream")
        if not self._auth():
            return
        # ---- Dropbox
        if u.path == "/2/users/get_current_account":
            return self._send(200, {"name": {"display_name": "Mario Prova"}, "email": "mario@example.com"})
        if u.path == "/2/files/list_folder":
            a = json.loads(body)
            base = a["path"]
            ents = [{".tag": "file", "name": p.rsplit("/", 1)[1], "path_lower": p, "path_display": p, "size": len(f["data"]),
                     "rev": f["rev"], "server_modified": "2026-10-22T10:00:00Z"} for p, f in Fake.files.items() if p.rsplit("/", 1)[0] == base]
            if base == "":
                ents.append({".tag": "folder", "name": "Progetti", "path_lower": "/progetti", "path_display": "/Progetti"})
            return self._send(200, {"entries": ents, "has_more": False, "cursor": "c"})
        if u.path == "/2/files/search_v2":
            q = json.loads(body)["query"].lower()
            ms = [{"metadata": {"metadata": {".tag": "file", "name": p.rsplit("/", 1)[1], "path_lower": p, "size": len(f["data"]), "rev": f["rev"]}}}
                  for p, f in Fake.files.items() if q in p]
            return self._send(200, {"matches": ms})
        if u.path == "/2/files/get_metadata":
            p = json.loads(body)["path"]
            f = Fake.files.get(p)
            if not f:
                return self._send(409, {"error_summary": "path/not_found/"})
            return self._send(200, {".tag": "file", "name": p.rsplit("/", 1)[1], "path_lower": p, "size": len(f["data"]), "rev": f["rev"],
                                    "server_modified": "2026-10-22T10:00:00Z"})
        if u.path == "/2/files/download":
            assert self.headers.get("Content-Type") is None, "download Dropbox senza Content-Type"
            p = json.loads(self.headers["Dropbox-API-Arg"])["path"]
            return self._send(200, Fake.files[p]["data"], "application/octet-stream")
        if u.path == "/2/files/upload":
            a = json.loads(self.headers["Dropbox-API-Arg"])
            p, mode = a["path"].lower(), a["mode"]
            cur = Fake.files.get(p)
            if isinstance(mode, dict) and cur and cur["rev"] != mode["update"]:
                return self._send(409, {"error_summary": "path/conflict/file/.."})
            if mode == "add" and cur:
                return self._send(409, {"error_summary": "path/conflict/file/.."})
            rev = f"r{int(time.time() * 1000)}{len(Fake.files)}"
            Fake.files[p] = {"data": body, "rev": rev}
            return self._send(200, {"name": p.rsplit("/", 1)[1], "path_lower": p, "rev": rev, "size": len(body)})
        # ---- Microsoft Graph
        if u.path == "/v1.0/me":
            return self._send(200, {"displayName": "Mario Prova", "userPrincipalName": "mario@contoso.com"})
        if u.path == "/v1.0/me/drive":
            return self._send(200, {"id": "D1", "driveType": "business"})
        if u.path == "/v1.0/drives/D1/items/root/children":
            return self._send(200, {"value": [self.gitem(i) for i, x in Fake.graph.items() if x["parent"] == "root"]})
        if u.path.startswith("/v1.0/drives/D1/items/") and m == "GET":
            i = u.path.split("/")[5]
            return self._send(200, self.gitem(i)) if i in Fake.graph else self._send(404, {"error": {"code": "itemNotFound", "message": "no"}})
        if m == "PUT" and u.path.endswith(":/content"):  # file nuovo: /drives/D1/items/root:/nome:/content
            parent, name = u.path.split("/items/")[1].split(":/")[0], u.path.split(":/")[1]
            beh = parse_qs(u.query).get("@microsoft.graph.conflictBehavior", ["fail"])[0]
            same = [i for i, x in Fake.graph.items() if x["parent"] == parent and x["name"] == name]
            if same and beh == "fail":
                return self._send(409, {"error": {"code": "nameAlreadyExists", "message": "esiste"}})
            i = same[0] if same else f"I{len(Fake.graph) + 1}"
            Fake.graph[i] = {"name": name, "data": body, "ctag": f"c{time.time()}", "parent": parent}
            return self._send(201, self.gitem(i))
        if m == "PUT" and u.path.endswith("/content"):
            i = u.path.split("/")[5]
            im = self.headers.get("If-Match")
            if im and im != Fake.graph[i]["ctag"]:
                return self._send(412, {"error": {"code": "resourceModified", "message": "cambiato"}})
            Fake.graph[i].update(data=body, ctag=f"c{time.time()}")
            return self._send(200, self.gitem(i))
        return self._send(404, {"error": "sconosciuto " + u.path})

    def gitem(self, i):
        x = Fake.graph[i]
        port = self.server.server_address[1]
        return {"id": i, "name": x["name"], "size": len(x["data"]), "cTag": x["ctag"], "eTag": "e" + x["ctag"],
                "lastModifiedDateTime": "2026-10-22T10:00:00.1234567Z", "file": {},
                "lastModifiedBy": {"user": {"displayName": "Luca Collega"}},
                "parentReference": {"driveId": "D1", "id": x["parent"]},
                "@microsoft.graph.downloadUrl": f"http://127.0.0.1:{port}/dl/{i}"}


# ------------------------------------------------------------------ prove
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("OK   " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def expect_error(name, fn, text):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        return check(name, text.lower() in str(e).lower(), str(e))
    check(name, False, "nessun errore")


def wait_job(jid, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = cloud.jobs.get(jid)
        if j["status"] == "done":
            return j["result"]
        if j["status"] == "error":
            raise RuntimeError(j["error"])
        time.sleep(0.05)
    raise TimeoutError(jid)


def browser(auth_url, **override):
    """Fa la parte del browser: il fornitore rimanda all'indirizzo di ritorno con code e state."""
    q = {k: v[0] for k, v in parse_qs(urlparse(auth_url).query).items()}
    code = "code-" + q["state"][:6]
    Fake.challenges[code] = (q["code_challenge"], q["redirect_uri"])
    params = {"code": code, "state": q["state"], **override}
    params = {k: v for k, v in params.items() if v is not None}
    url = q["redirect_uri"].replace("localhost", "127.0.0.1") + "?" + urlencode(params)
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.read().decode("utf-8"), q


def age(path):
    t = time.time() - 5
    os.utime(path, (t, t))


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    db, gr = cloud.PROVIDERS["dropbox"], cloud.PROVIDERS["onedrive"]
    db.API, db.CONTENT, db.TOKEN, db.AUTH = base + "/2", base + "/2", base + "/oauth2/token", base + "/oauth2/authorize"
    gr.API, gr.LOGIN = base + "/v1.0", base
    port = free_port()

    # --- configurazione: servizi nascosti finche' non c'e' l'ID
    st = cloud.status()
    check("senza ID tutti i servizi sono nascosti", not any(s["configurato"] for s in st["servizi"]))
    expect_error("accesso a un servizio non configurato", lambda: cloud.login_start("dropbox", False), "non e' configurato")
    cloud.set_config({"servizi": {"dropbox": {"client_id": "id-prova"}, "onedrive": {"client_id": "id-prova", "tenant": "common"},
                                  "gdrive": {"client_id": "id-g", "client_secret": "segreto-g"}}, "porta": port})
    st = {s["id"]: s for s in cloud.status()["servizi"]}
    check("con l'ID il servizio compare", st["dropbox"]["configurato"] and st["onedrive"]["configurato"] and not st["autodesk"]["configurato"])
    raw = (TMP / "dati" / "cloud.json").read_text("utf-8")
    check("segreto Google cifrato nella configurazione", "segreto-g" not in raw and cloud.config()["gdrive"]["client_secret"] == "segreto-g")
    check("redirect Google su 127.0.0.1", cloud.config_view()["servizi"]["gdrive"]["redirect"] == f"http://127.0.0.1:{port}/")
    expect_error("porta non valida rifiutata", lambda: cloud.set_config({"porta": 80}), "porta non valida")

    # --- accesso OAuth PKCE fino al ritorno su localhost
    r = cloud.login_start("dropbox", open_browser=False)
    q = {k: v[0] for k, v in parse_qs(urlparse(r["url"]).query).items()}
    check("URL di accesso con PKCE S256", q.get("code_challenge_method") == "S256" and len(q.get("code_challenge", "")) == 43
          and q["redirect_uri"] == f"http://localhost:{port}/callback" and q["token_access_type"] == "offline", r["url"])
    page, _ = browser(r["url"])
    check("pagina di ritorno 'Accesso completato'", "Accesso completato" in page)
    res = wait_job(r["job"])
    check("token ottenuto e account letto", res["account"]["email"] == "mario@example.com", res)
    rawt = (TMP / "dati" / "cloud_token.bin").read_bytes()
    check("token cifrato con DPAPI sul disco", b"tok-1" not in rawt and b"rt-1" not in rawt and cloud._tokens()["dropbox"]["access_token"] == "tok-1")
    time.sleep(0.3)
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        closed = False
    except OSError:
        closed = True
    check("server di ritorno chiuso dopo l'accesso", closed)

    # errori del ritorno
    r = cloud.login_start("onedrive", open_browser=False)
    page, _ = browser(r["url"], code=None, error="access_denied", error_description=None)
    check("pagina di ritorno con accesso negato", "Accesso non completato" in page)
    expect_error("job: accesso negato", lambda: wait_job(r["job"]), "accesso negato")
    r = cloud.login_start("onedrive", open_browser=False)
    page, q = browser(r["url"].replace("state=", "state=XX"))
    check("state sconosciuto respinto", "non riconosciuta" in page)
    cloud.login_cancel("onedrive")
    expect_error("accesso annullato", lambda: wait_job(r["job"]), "annullato")
    old = cloud.LOGIN_TIMEOUT
    cloud.LOGIN_TIMEOUT = 0.5
    r = cloud.login_start("onedrive", open_browser=False)
    expect_error("tempo scaduto", lambda: wait_job(r["job"]), "tempo scaduto")
    cloud.LOGIN_TIMEOUT = old
    time.sleep(0.3)
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", port))
    blocker.listen(1)
    expect_error("porta occupata", lambda: cloud.login_start("onedrive", False), "occupata")
    blocker.close()
    # PKCE sbagliato: il fornitore rifiuta il codice
    r = cloud.login_start("onedrive", open_browser=False)
    qq = {k: v[0] for k, v in parse_qs(urlparse(r["url"]).query).items()}
    Fake.challenges["bad"] = ("x" * 43, qq["redirect_uri"])
    urllib.request.urlopen(qq["redirect_uri"].replace("localhost", "127.0.0.1") + "?" + urlencode({"code": "bad", "state": qq["state"]}), timeout=5).read()
    expect_error("codice con PKCE errato rifiutato", lambda: wait_job(r["job"]), "rifiutato l'accesso")
    # Microsoft: accesso completo
    r = cloud.login_start("onedrive", open_browser=False)
    check("Microsoft: tenant nell'URL", f"{base}/common/oauth2/v2.0/authorize" in r["url"] and "Files.ReadWrite.All" in r["url"])
    browser(r["url"])
    res = wait_job(r["job"])
    check("Microsoft: account letto", res["account"]["email"] == "mario@contoso.com")

    # --- Dropbox: elenco, ricerca, apertura, salvataggio, conflitto, copia
    Fake.files = {"/progetti/pianta.dxf": {"data": b"0\nSECTION\n", "rev": "a1"}, "/note.txt": {"data": b"ciao", "rev": "b1"}}
    items = cloud.handle("list", {"svc": "dropbox"}, {})["items"]
    check("Dropbox: radice elencata (cartelle prima)", items[0]["dir"] and items[0]["name"] == "Progetti" and any(i["name"] == "note.txt" for i in items))
    items = cloud.handle("list", {"svc": "dropbox", "id": "/progetti"}, {})["items"]
    check("Dropbox: sottocartella", [i["name"] for i in items] == ["pianta.dxf"])
    items = cloud.handle("search", {"svc": "dropbox", "q": "pianta"}, {})["items"]
    check("Dropbox: ricerca", len(items) == 1 and items[0]["id"] == "/progetti/pianta.dxf")
    o = wait_job(cloud.handle("open", {"svc": "dropbox", "id": "/note.txt"}, {})["job"])
    p = o["path"]
    check("apertura: file scaricato nella cache", Path(p).read_bytes() == b"ciao" and Path(p).name == "note.txt")
    check("nessun salvataggio in sospeso dopo l'apertura", cloud.pending()["files"] == [])
    Path(p).write_bytes(b"ciao modificato")
    check("salvataggio appena scritto non ancora caricato (attesa 1,5 s)", cloud.pending()["files"] == [])
    age(p)
    pend = cloud.pending()["files"]
    check("salvataggio in sospeso rilevato", len(pend) == 1 and pend[0]["servizio"] == "dropbox")
    up = wait_job(cloud.handle("upload", {"path": p}, {})["job"])
    check("caricamento della nuova versione", up.get("ok") and Fake.files["/note.txt"]["data"] == b"ciao modificato")
    check("dopo il caricamento niente in sospeso", cloud.pending()["files"] == [])
    # la stessa apertura non riscarica se la versione e' uguale
    n = len(Fake.calls)
    wait_job(cloud.handle("open", {"svc": "dropbox", "id": "/note.txt"}, {})["job"])
    check("riapertura senza nuovo download", not any(c[1] == "/2/files/download" for c in Fake.calls[n:]))
    # un collega salva sul cloud
    Fake.files["/note.txt"] = {"data": b"versione del collega", "rev": "z9"}
    check("controllo: versione remota cambiata", cloud.check(p)["cambiato"])
    Path(p).write_bytes(b"le mie modifiche")
    age(p)
    up = wait_job(cloud.handle("upload", {"path": p}, {})["job"])
    check("conflitto di versione segnalato", up.get("conflitto") and Fake.files["/note.txt"]["data"] == b"versione del collega", up)
    cloud.skip(p)
    check("'Decidi dopo': non riprova da solo", cloud.pending()["files"] == [] and cloud.opened()["files"][0]["stato"] == "da caricare")
    cp = wait_job(cloud.handle("upload_copy", {"path": p}, {})["job"])
    copies = [k for k in Fake.files if "(copia" in k]
    check("'Salva come copia' accanto all'originale", len(copies) == 1 and Fake.files[copies[0]]["data"] == b"le mie modifiche"
          and Fake.files["/note.txt"]["data"] == b"versione del collega", cp)
    # sovrascrittura forzata
    Path(p).write_bytes(b"forzato")
    Fake.files[copies[0]]["rev"] = "cambiata"
    age(p)
    up = wait_job(cloud.handle("upload", {"path": p}, {})["job"])
    check("conflitto anche sulla copia", up.get("conflitto"))
    up = wait_job(cloud.handle("upload", {"path": p, "force": "1"}, {})["job"])
    check("'Sovrascrivi' forza il caricamento", up.get("ok") and Fake.files[copies[0]]["data"] == b"forzato")
    # "Apri la versione del cloud"
    Fake.files[copies[0]] = {"data": b"dal cloud", "rev": "nuova"}
    wait_job(cloud.handle("refresh", {"path": p}, {})["job"])
    check("versione del cloud riscaricata sopra la copia locale", Path(p).read_bytes() == b"dal cloud" and not cloud.check(p)["cambiato"])
    # Salva nel cloud
    src = TMP / "nuovo.txt"
    src.write_bytes(b"nuovo file")
    r = wait_job(cloud.handle("save_new", {}, {"svc": "dropbox", "folder": "/progetti", "name": "nuovo.txt", "src": str(src)})["job"])
    check("Salva nel cloud: file nuovo", r.get("ok") and Fake.files["/progetti/nuovo.txt"]["data"] == b"nuovo file")
    r = wait_job(cloud.handle("save_new", {}, {"svc": "dropbox", "folder": "/progetti", "name": "nuovo.txt", "src": str(src)})["job"])
    check("Salva nel cloud: nome gia' esistente segnalato", r.get("esiste"))
    src.write_bytes(b"sostituito")
    r = wait_job(cloud.handle("save_new", {}, {"svc": "dropbox", "folder": "/progetti", "name": "nuovo.txt", "src": str(src), "replace": True})["job"])
    check("Salva nel cloud: sostituzione confermata", r.get("ok") and Fake.files["/progetti/nuovo.txt"]["data"] == b"sostituito")
    r = wait_job(cloud.handle("save_new", {}, {"svc": "dropbox", "folder": "", "name": 'a<b>:c?.txt', "src": str(src)})["job"])
    check("nome con caratteri non validi ripulito", "/a_b__c_.txt" in Fake.files, list(Fake.files))

    # --- Microsoft Graph: elenco, apertura, conflitto con If-Match (412), nome esistente (409)
    Fake.graph = {"I1": {"name": "relazione.docx", "data": b"PK-docx", "ctag": "c1", "parent": "root"}}
    roots = cloud.handle("list", {"svc": "onedrive"}, {})["items"]
    check("Graph: radici (OneDrive, condivisi, SharePoint)", [x["id"] for x in roots] == ["d|D1|root", "shared", "sites"])
    items = cloud.handle("list", {"svc": "onedrive", "id": "d|D1|root"}, {})["items"]
    check("Graph: contenuto della cartella", items[0]["id"] == "d|D1|I1" and items[0]["by"] == "Luca Collega" and items[0]["modified"] > 0)
    o = wait_job(cloud.handle("open", {"svc": "onedrive", "id": "d|D1|I1"}, {})["job"])
    gp = o["path"]
    check("Graph: download dal downloadUrl", Path(gp).read_bytes() == b"PK-docx")
    Path(gp).write_bytes(b"PK-docx-2")
    age(gp)
    up = wait_job(cloud.handle("upload", {"path": gp}, {})["job"])
    check("Graph: caricamento con If-Match", up.get("ok") and Fake.graph["I1"]["data"] == b"PK-docx-2")
    Fake.graph["I1"]["ctag"] = "c-collega"
    Path(gp).write_bytes(b"PK-docx-3")
    age(gp)
    up = wait_job(cloud.handle("upload", {"path": gp}, {})["job"])
    check("Graph: conflitto (autore e data del collega)", up.get("conflitto") and up["remoto"]["autore"] == "Luca Collega", up)
    r = wait_job(cloud.handle("save_new", {}, {"svc": "onedrive", "folder": "d|D1|root", "name": "relazione.docx", "src": gp})["job"])
    check("Graph: nome esistente (409) segnalato", r.get("esiste"))

    # --- rinnovo del token e revoca
    tk = cloud._tokens()
    tk["dropbox"]["expires_at"] = 0
    cloud._save_tokens(tk)
    cloud.handle("list", {"svc": "dropbox"}, {})
    check("token scaduto rinnovato con il refresh token", cloud._tokens()["dropbox"]["access_token"] == "tok-2" and cloud._tokens()["dropbox"]["refresh_token"] == "rt-2")
    Fake.access.discard("tok-2")
    Fake.refresh_ok = False
    r = cloud.handle("list", {"svc": "dropbox"}, {})
    check("refresh token revocato: si chiede un nuovo accesso", r.get("ok") is False and r.get("login") and "dropbox" not in cloud._tokens(), r)
    Fake.refresh_ok = True
    r = cloud.handle("list", {"svc": "dropbox"}, {})
    check("servizio non collegato: messaggio chiaro", r.get("ok") is False and "non sei collegato" in r["errore"])

    # --- errore di rete
    gr.API = "http://127.0.0.1:9"
    r = cloud.handle("list", {"svc": "onedrive"}, {})
    check("errore di rete: messaggio chiaro", r.get("ok") is False and "Connessione non riuscita" in r["errore"], r)
    gr.API = base + "/v1.0"

    # --- uscita
    cloud.logout("onedrive")
    check("Esci cancella il token", "onedrive" not in cloud._tokens() and not {s["id"]: s for s in cloud.status()["servizi"]}["onedrive"]["connesso"])

    srv.shutdown()
    ok = sum(1 for _, v in RESULTS if v)
    print(f"\n{ok}/{len(RESULTS)} prove superate")
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
