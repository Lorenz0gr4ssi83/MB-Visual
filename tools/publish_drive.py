"""Carica i setup di una versione nella cartella Google Drive di distribuzione e sposta quelli vecchi nella sottocartella "Old".

Uso:  python tools/publish_drive.py --login                  (una volta sola: autorizza l'account Google nel browser)
      python tools/publish_drive.py <file> [<file> ...]      (es. MBVisual-Setup-1.6.5.exe MBVisual-1.6.5-mac.dmg)

Cartella di destinazione: DRIVE_FOLDER (o variabile MBV_DRIVE_FOLDER). "Old" si crea solo se non esiste; si spostano li' solo
i file di MB Visual gia' presenti nella cartella (MBVisual-Setup-*.exe, MBVisual-*-mac.dmg, MBVisual-*.zip) di una versione
DIVERSA da quella caricata (il .dmg che arriva dopo non sposta il setup Windows della stessa versione) o con lo stesso nome
(ricaricamento), mai altri file. Lo chiama da solo tools/build_portable.py quando pubblica in "App per PC" (salvo --no-drive).
MB Visual Admin NON va caricato qui (e' solo per il proprietario).
Client OAuth: quello "Applicazione desktop" del progetto Google mb-visual (%USERPROFILE%\\.mbvisual\\licenze\\cloud_ids.json,
voce gdrive); token con rinnovo in %USERPROFILE%\\.mbvisual\\licenze\\drive_token.json (fuori da OneDrive e dal repository).
"""
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

DRIVE_FOLDER = os.environ.get("MBV_DRIVE_FOLDER") or "1g0K6LkMuwgx4O1s1Pul32pgVDmpjNO1e"
SECRETS = Path.home() / ".mbvisual" / "licenze"
TOKEN = SECRETS / "drive_token.json"
SCOPE = "https://www.googleapis.com/auth/drive"  # serve per spostare file non creati da questo strumento
API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
OURS = re.compile(r"^MBVisual-(Setup-[\d.]+\.exe|[\d.]+-mac\.dmg|.*\.zip)$", re.I)
VER = re.compile(r"(\d+\.\d+\.\d+)")
FOLDER_MIME = "application/vnd.google-apps.folder"
CHUNK = 32 * 1024 * 1024  # multiplo di 256 KiB


def _client() -> dict:
    c = json.loads((SECRETS / "cloud_ids.json").read_text("utf-8"))["gdrive"]
    return {"client_id": c["client_id"], "client_secret": c["client_secret"]}


def _post_form(url: str, form: dict) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def login() -> None:
    c = _client()
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [""])[0] == state:
                got.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<p style='font-family:sans-serif'>MB Visual: autorizzazione ricevuta, puoi chiudere questa pagina.</p>".encode())

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    redirect = f"http://127.0.0.1:{srv.server_port}/"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": c["client_id"], "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "access_type": "offline", "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256"})
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("Si apre il browser: scegli l'account Google che possiede la cartella e consenti l'accesso a Drive.")
    webbrowser.open(url)
    t0 = time.time()
    while "code" not in got and "error" not in got and time.time() - t0 < 600:
        time.sleep(0.5)
    srv.shutdown()
    if "code" not in got:
        sys.exit("Autorizzazione non ricevuta: " + got.get("error", "tempo scaduto"))
    tok = _post_form("https://oauth2.googleapis.com/token", {
        **c, "code": got["code"], "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect})
    if not tok.get("refresh_token"):
        sys.exit("Google non ha restituito il token di rinnovo: riprovare con --login")
    SECRETS.mkdir(parents=True, exist_ok=True)
    TOKEN.write_text(json.dumps({"refresh_token": tok["refresh_token"]}), "utf-8")
    print("Autorizzazione salvata in", TOKEN)


def _access() -> str:
    if not TOKEN.exists():
        sys.exit("Manca l'autorizzazione: python tools/publish_drive.py --login")
    rt = json.loads(TOKEN.read_text("utf-8"))["refresh_token"]
    return _post_form("https://oauth2.googleapis.com/token", {**_client(), "refresh_token": rt, "grant_type": "refresh_token"})["access_token"]


def _api(tok: str, method: str, url: str, body=None, params=None) -> dict:
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({**params, "supportsAllDrives": "true"})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "authorization": "Bearer " + tok, **({"content-type": "application/json"} if data else {})})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def _list(tok: str, q: str) -> list:
    out, page = [], None
    while True:
        p = {"q": q, "fields": "nextPageToken, files(id, name, mimeType)", "pageSize": "1000", "includeItemsFromAllDrives": "true"}
        if page:
            p["pageToken"] = page
        r = _api(tok, "GET", API + "/files", params=p)
        out += r.get("files", [])
        page = r.get("nextPageToken")
        if not page:
            return out


def _old_folder(tok: str) -> str:
    found = _list(tok, f"'{DRIVE_FOLDER}' in parents and name = 'Old' and mimeType = '{FOLDER_MIME}' and trashed = false")
    if found:
        return found[0]["id"]
    made = _api(tok, "POST", API + "/files", {"name": "Old", "mimeType": FOLDER_MIME, "parents": [DRIVE_FOLDER]}, {"fields": "id"})
    print("Creata la cartella Old")
    return made["id"]


def _upload(tok: str, path: Path) -> str:
    size = path.stat().st_size
    meta = json.dumps({"name": path.name, "parents": [DRIVE_FOLDER]}).encode()
    req = urllib.request.Request(UPLOAD + "?uploadType=resumable&supportsAllDrives=true", data=meta, method="POST", headers={
        "authorization": "Bearer " + tok, "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "application/octet-stream", "x-upload-content-length": str(size)})
    with urllib.request.urlopen(req, timeout=60) as r:
        session = r.headers["location"]
    sent = 0
    with path.open("rb") as f:
        while sent < size:
            f.seek(sent)
            chunk = f.read(CHUNK)
            end = sent + len(chunk) - 1
            for attempt in range(6):
                req = urllib.request.Request(session, data=chunk, method="PUT", headers={
                    "content-length": str(len(chunk)), "content-range": f"bytes {sent}-{end}/{size}"})
                try:
                    with urllib.request.urlopen(req, timeout=600) as r:
                        return json.loads(r.read())["id"]  # ultimo pezzo: file completo
                except urllib.error.HTTPError as e:
                    if e.code == 308:  # pezzo ricevuto, continua
                        rng = e.headers.get("range")
                        sent = int(rng.split("-")[1]) + 1 if rng else sent
                        break
                    if e.code >= 500 and attempt < 5:
                        time.sleep(5 * (attempt + 1))
                        continue
                    raise
                except (urllib.error.URLError, TimeoutError, ConnectionError):
                    if attempt == 5:
                        raise
                    time.sleep(5 * (attempt + 1))
            print(f"  {path.name}: {sent * 100 // size}%")
    raise RuntimeError("caricamento non concluso: " + path.name)


def publish(files: list) -> None:
    paths = [Path(f).resolve() for f in files]
    for p in paths:
        if not p.is_file():
            sys.exit("File non trovato: " + str(p))
        if "admin" in p.name.lower():
            sys.exit("MB Visual Admin non va nella cartella di distribuzione: " + p.name)
    names = {p.name for p in paths}
    versions = {m.group(1) for p in paths if (m := VER.search(p.name))}
    tok = _access()
    old = _old_folder(tok)
    for f in _list(tok, f"'{DRIVE_FOLDER}' in parents and trashed = false and mimeType != '{FOLDER_MIME}'"):
        v = VER.search(f["name"])
        if OURS.match(f["name"]) and (f["name"] in names or not v or v.group(1) not in versions):
            _api(tok, "PATCH", f"{API}/files/{f['id']}", {}, {"addParents": old, "removeParents": DRIVE_FOLDER, "fields": "id"})
            print("Spostato in Old:", f["name"])
    for p in paths:
        tok = _access()  # i caricamenti lunghi possono superare l'ora di validita' del token
        print("Caricamento:", p.name)
        _upload(tok, p)
        print("Caricato:", p.name)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if "--login" in sys.argv:
        login()
    elif len(sys.argv) > 1:
        publish([a for a in sys.argv[1:] if not a.startswith("--")])
    else:
        print(__doc__)
