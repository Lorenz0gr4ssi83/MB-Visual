"""Archivi cloud senza sincronizzazione: SharePoint/OneDrive (Microsoft Graph), Google Drive, Dropbox,
Autodesk Construction Cloud / BIM 360 (APS Data Management).

- Accesso: OAuth 2.0 con PKCE nel browser predefinito, ritorno su http://localhost:<porta>/callback (porta fissa,
  47613 se non configurata: Dropbox e Autodesk vogliono l'indirizzo esatto registrato).
- Token: un file cifrato con DPAPI (leggibile solo dall'utente di Windows che l'ha scritto), %LOCALAPPDATA%/MBVisual.
- Apertura: il file si scarica in TEMP_DIR/cloud/<servizio>/<chiave>/<nome> e si apre nel visualizzatore giusto;
  quando il visualizzatore (o un altro programma) lo salva, l'interfaccia (ui/js/cloud.js) lo vede in `pending`
  e lo ricarica sul cloud controllando la versione: se nel frattempo qualcuno l'ha cambiato si chiede cosa fare.
- Servizi senza ID applicazione (cloud_ids.py o %LOCALAPPDATA%/MBVisual/cloud.json) restano nascosti.
Solo librerie standard (urllib): nessuna dipendenza in piu'.
"""
import base64
import ctypes
import hashlib
import json
import math
import os
import re
import secrets
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, build_opener

from . import jobs
from .paths import TEMP_DIR, UI_DIR
from .i18n import t

DATA_DIR = Path(os.environ.get("MBV_CLOUD_DIR") or (Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "MBVisual"))
CONFIG_FILE = DATA_DIR / "cloud.json"
TOKEN_FILE = DATA_DIR / "cloud_token.bin"
CACHE = TEMP_DIR / "cloud"
DEFAULT_PORT = 47613
LOGIN_TIMEOUT = 300
GUIDE = UI_DIR / "guide" / "archivi-cloud.md"

_LOCK = threading.RLock()
_OPENER = build_opener()


class CloudError(Exception):
    def __init__(self, msg, login=False):
        super().__init__(msg)
        self.login = login  # serve un nuovo accesso


class Conflict(Exception):
    """La versione sul cloud non e' quella scaricata: qualcuno l'ha modificata nel frattempo."""
    def __init__(self, meta):
        super().__init__("conflitto di versione")
        self.meta = meta


class Exists(Exception):
    """Esiste gia' un file con lo stesso nome nella cartella di destinazione."""


# ------------------------------------------------------------------ DPAPI (cifratura legata all'utente di Windows)
class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


_ENTROPY = b"MB Visual - archivi cloud"


def _dpapi(data: bytes, protect: bool) -> bytes:
    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    buf = ctypes.create_string_buffer(data, len(data))
    ent = ctypes.create_string_buffer(_ENTROPY, len(_ENTROPY))
    inp = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    eb = _Blob(len(_ENTROPY), ctypes.cast(ent, ctypes.POINTER(ctypes.c_char)))
    out = _Blob()
    if protect:
        ok = crypt32.CryptProtectData(ctypes.byref(inp), ctypes.c_wchar_p("MB Visual"), ctypes.byref(eb), None, None, 1, ctypes.byref(out))
    else:
        ok = crypt32.CryptUnprotectData(ctypes.byref(inp), None, ctypes.byref(eb), None, None, 1, ctypes.byref(out))
    if not ok:
        raise OSError("DPAPI non riuscita (" + str(ctypes.GetLastError()) + ")")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))


def _tokens() -> dict:
    with _LOCK:
        try:
            return json.loads(_dpapi(TOKEN_FILE.read_bytes(), False).decode("utf-8"))
        except FileNotFoundError:
            return {}
        except Exception:  # noqa: BLE001 - file di un altro utente o rovinato: si riparte da zero
            return {}


def _save_tokens(d: dict):
    with _LOCK:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = TOKEN_FILE.with_suffix(".tmp")
        tmp.write_bytes(_dpapi(json.dumps(d).encode("utf-8"), True))
        os.replace(tmp, TOKEN_FILE)


# ------------------------------------------------------------------ configurazione (ID applicazione)
def _defaults() -> dict:
    try:
        from .cloud_ids import IDS
        return json.loads(json.dumps(IDS))
    except ImportError:
        return {}


def config() -> dict:
    cfg = {k: {} for k in PROVIDERS}
    for k, v in _defaults().items():
        cfg.setdefault(k, {}).update({a: b for a, b in v.items() if b})
    try:
        user = json.loads(CONFIG_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        user = {}
    for k, v in (user.get("servizi") or {}).items():
        if k in cfg:
            cfg[k].update({a: b for a, b in v.items() if b not in (None, "")})
    for k, v in cfg.items():
        if v.get("client_secret_dpapi"):
            try:
                v["client_secret"] = _dpapi(base64.b64decode(v.pop("client_secret_dpapi")), False).decode("utf-8")
            except Exception:  # noqa: BLE001
                v.pop("client_secret_dpapi", None)
    cfg["_port"] = int(user.get("porta") or DEFAULT_PORT)
    return cfg


def configured(svc: str, cfg=None) -> bool:
    c = (cfg or config()).get(svc) or {}
    return bool(c.get("client_id")) and (not PROVIDERS[svc].needs_secret or bool(c.get("client_secret")))


def set_config(body: dict) -> dict:
    with _LOCK:
        try:
            user = json.loads(CONFIG_FILE.read_text("utf-8"))
        except (OSError, ValueError):
            user = {}
        serv = user.setdefault("servizi", {})
        for svc, vals in (body.get("servizi") or {}).items():
            if svc not in PROVIDERS:
                continue
            cur = serv.setdefault(svc, {})
            for k in ("client_id", "tenant"):
                if k in vals:
                    cur[k] = str(vals[k] or "").strip()
            sec = vals.get("client_secret")
            if sec == "":  # cancellato esplicitamente
                cur.pop("client_secret_dpapi", None)
            elif sec:
                cur["client_secret_dpapi"] = base64.b64encode(_dpapi(str(sec).strip().encode("utf-8"), True)).decode()
        if body.get("porta"):
            p = int(body["porta"])
            if not 1024 <= p <= 65535:
                raise CloudError(t("srv_cloud.porta_non_valida_1024_65535"))
            user["porta"] = p
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(user, indent=2), "utf-8")
    return {"ok": True}


# ------------------------------------------------------------------ HTTP
def _http(method, url, headers=None, data=None, timeout=90, out=None, update=None, total=0):
    """Richiesta HTTP senza eccezioni per i codici di errore: (stato, intestazioni, corpo).
    Con `out` (file aperto in scrittura) un corpo 200/206 si scrive li' a blocchi."""
    req = Request(url, data=data, method=method, headers=headers or {})
    try:
        resp = _OPENER.open(req, timeout=timeout)
    except HTTPError as e:
        try:
            body = e.read()
        except OSError:
            body = b""
        return e.code, e.headers, body
    except (URLError, TimeoutError, ConnectionError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise CloudError(t("srv_cloud.connessione_non_riuscita_0_controlla", reason)) from e
    with resp:
        if out is not None:
            total = total or int(resp.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if update and total:
                    update(min(0.99, done / total), f"Download {done * 100 // total}%")
            return resp.status, resp.headers, b""
        return resp.status, resp.headers, resp.read()


def _jsonb(b: bytes):
    try:
        return json.loads(b.decode("utf-8")) if b else {}
    except (ValueError, UnicodeDecodeError):
        return {}


def _err_text(body: bytes) -> str:
    j = _jsonb(body)
    if isinstance(j, dict):
        e = j.get("error")
        if isinstance(e, dict):
            return str(e.get("message") or e.get("code") or "")
        if isinstance(e, str):
            return str(j.get("error_description") or j.get("error_summary") or e)
        for k in ("error_summary", "developerMessage", "reason", "message", "detail"):
            if j.get(k):
                return str(j[k])
        if isinstance(j.get("errors"), list) and j["errors"]:
            x = j["errors"][0]
            return str(x.get("detail") or x.get("title") or x)
    return body[:200].decode("utf-8", "replace")


def _status_error(nome: str, st: int, body: bytes) -> CloudError:
    det = _err_text(body)
    if st == 401:
        return CloudError(t("srv_cloud.0_accesso_scaduto_revocato_accedi", nome), login=True)
    if st == 403:
        return CloudError(t("srv_cloud.0_permesso_negato", nome) + (f" ({det})" if det else ""))
    if st == 404:
        return CloudError(t("srv_cloud.0_elemento_non_trovato_spostato", nome))
    if st == 429:
        return CloudError(t("srv_cloud.0_troppe_richieste_riprova_tra", nome))
    return CloudError(t("srv_cloud.0_errore_1", nome, st) + (f" - {det}" if det else ""))


def _ts(s) -> float:
    """Data ISO 8601 (anche con frazioni e Z) -> secondi epoch."""
    if not s:
        return 0
    try:
        s = str(s).replace("Z", "+00:00")
        s = re.sub(r"\.(\d{6})\d+", r".\1", s)
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return 0


def _pkce():
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


# ------------------------------------------------------------------ sessione autenticata di un servizio
class Session:
    def __init__(self, svc: str):
        self.svc = svc
        self.prov = PROVIDERS[svc]
        self.cfg = config()
        tok = _tokens().get(svc)
        if not tok:
            raise CloudError(t("srv_cloud.0_non_sei_collegato", self.prov.nome), login=True)
        self.tok = tok

    def access_token(self) -> str:
        if self.tok.get("expires_at", 0) - 90 < time.time():
            self.refresh()
        return self.tok["access_token"]

    def refresh(self):
        rt = self.tok.get("refresh_token")
        if not rt:
            raise CloudError(t("srv_cloud.0_accesso_scaduto_accedi_nuovo", self.prov.nome), login=True)
        c = self.cfg[self.svc]
        form = {"grant_type": "refresh_token", "refresh_token": rt, "client_id": c["client_id"], **self.prov.token_extra(c)}
        st, _, body = _http("POST", self.prov.token_url(c), {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
                            urlencode(form).encode())
        if st != 200:
            if st in (400, 401):  # refresh token scaduto o revocato: si esce dal servizio
                with _LOCK:
                    toks = _tokens()
                    toks.pop(self.svc, None)
                    _save_tokens(toks)
                raise CloudError(t("srv_cloud.0_accesso_scaduto_revocato_accedi", self.prov.nome), login=True)
            raise _status_error(self.prov.nome, st, body)
        j = _jsonb(body)
        self.tok["access_token"] = j["access_token"]
        self.tok["expires_at"] = time.time() + int(j.get("expires_in") or 3600)
        if j.get("refresh_token"):  # Microsoft e Autodesk ruotano il refresh token
            self.tok["refresh_token"] = j["refresh_token"]
        with _LOCK:
            toks = _tokens()
            toks[self.svc] = self.tok
            _save_tokens(toks)

    def call(self, method, url, *, params=None, headers=None, data=None, js=None, auth=True, ok=(200, 201, 204),
             out=None, update=None, raw=False, ctype="application/json", total=0):
        if params:
            url += ("&" if "?" in url else "?") + urlencode(params)
        st, hd, body = 0, {}, b""
        for attempt in range(4):
            h = dict(headers or {})
            if auth:
                h["Authorization"] = "Bearer " + self.access_token()
            payload = data
            if js is not None:
                payload = json.dumps(js).encode("utf-8")
                h.setdefault("Content-Type", ctype)
            if hasattr(payload, "seek"):
                payload.seek(0)
            if out is not None:
                out.seek(0)
                out.truncate()
            st, hd, body = _http(method, url, h, payload, out=out if out is not None else None, update=update, total=total)
            if st == 401 and auth and attempt == 0:
                self.refresh()
                continue
            if st in (429, 502, 503, 504) and attempt < 3:
                try:
                    wait = int(hd.get("Retry-After") or 0)
                except (TypeError, ValueError):
                    wait = 0
                time.sleep(min(max(wait, 2 ** attempt), 30))
                continue
            break
        if raw:
            return st, hd, body
        if st not in ok:
            raise _status_error(self.prov.nome, st, body)
        if out is not None:
            return {}
        ct = (hd.get("Content-Type") or "") if hd else ""
        return _jsonb(body) if "json" in ct or body[:1] in (b"{", b"[") else body


def _put_file(sess, url, src: Path, start, length, headers, update=None, total=None, done=0, auth=False, method="PUT", ok=(200, 201, 202, 204, 308)):
    """Invia un tratto del file senza caricarlo tutto in memoria."""
    with open(src, "rb") as f:
        f.seek(start)
        data = f.read(length)
    st, hd, body = sess.call(method, url, headers={**headers, "Content-Length": str(len(data))}, data=data, auth=auth, raw=True)
    if st not in ok:
        return st, hd, body
    if update and total:
        update(min(0.99, (done + len(data)) / total), t("srv_cloud.caricamento_0", (done + len(data)) * 100 // total))
    return st, hd, body


# ------------------------------------------------------------------ fornitori
class Provider:
    key = ""
    nome = ""
    needs_secret = False
    can_search_root = True

    def redirect(self, port):
        return f"http://localhost:{port}/callback"

    def authorize(self, c) -> tuple[str, dict]:
        raise NotImplementedError

    def token_url(self, c) -> str:
        raise NotImplementedError

    def token_extra(self, c) -> dict:
        return {}

    def revoke(self, c, tok):
        pass


def _item(id_, name, dir_=False, size=0, modified=0, **kw):
    return {"id": id_, "name": name, "dir": dir_, "size": size or 0, "modified": modified or 0, **kw}


# ---- Microsoft Graph (OneDrive personale/aziendale e SharePoint)
class Graph(Provider):
    key, nome = "onedrive", "OneDrive / SharePoint"
    API = "https://graph.microsoft.com/v1.0"
    LOGIN = "https://login.microsoftonline.com"
    SCOPES = "offline_access User.Read Files.ReadWrite.All Sites.ReadWrite.All"
    SMALL = 4 * 1024 * 1024
    CHUNK = 320 * 1024 * 32  # 10 MiB, multiplo di 320 KiB come chiede Graph

    def authorize(self, c):
        return f"{self.LOGIN}/{c.get('tenant') or 'common'}/oauth2/v2.0/authorize", {"scope": self.SCOPES, "prompt": "select_account"}

    def token_url(self, c):
        return f"{self.LOGIN}/{c.get('tenant') or 'common'}/oauth2/v2.0/token"

    def token_extra(self, c):
        return {"scope": self.SCOPES}

    def account(self, s):
        me = s.call("GET", self.API + "/me")
        return {"nome": me.get("displayName") or "", "email": me.get("mail") or me.get("userPrincipalName") or ""}

    def _ids(self, iid):
        p = iid.split("|", 2)
        if len(p) != 3 or p[0] != "d":
            raise CloudError(t("srv_cloud.scegli_cartella_onedrive_raccolta_documenti"))
        return p[1], p[2]

    def _map(self, x):
        src = x.get("remoteItem") or x
        drive = (src.get("parentReference") or {}).get("driveId") or (x.get("parentReference") or {}).get("driveId")
        return _item(f"d|{drive}|{src['id']}", x.get("name") or src.get("name"), "folder" in src or "package" in src,
                     src.get("size"), _ts(src.get("lastModifiedDateTime") or x.get("lastModifiedDateTime")),
                     by=((src.get("lastModifiedBy") or {}).get("user") or {}).get("displayName", ""))

    def _pages(self, s, url, params=None, mapper=None, limit=5000):
        out = []
        while url and len(out) < limit:
            j = s.call("GET", url, params=params)
            params = None
            out += [mapper(x) if mapper else x for x in j.get("value", [])]
            url = j.get("@odata.nextLink")
        return out

    def roots(self, s):
        d = s.call("GET", self.API + "/me/drive", params={"$select": "id,driveType"})
        return [_item(f"d|{d['id']}|root", t("srv_cloud.mio_onedrive"), True, kind="drive"),
                _item("shared", t("srv_cloud.condivisi_me"), True, kind="shared"),
                _item("sites", t("srv_cloud.siti_sharepoint"), True, kind="sites")]

    def list(self, s, fid):
        if fid == "shared":
            return self._pages(s, self.API + "/me/drive/sharedWithMe", mapper=self._map)
        if fid == "sites":
            seen, out = set(), []
            for url, params in ((self.API + "/me/followedSites", None), (self.API + "/sites", {"search": "*"})):
                try:
                    for x in self._pages(s, url, params, limit=500):
                        if x.get("id") not in seen:
                            seen.add(x["id"])
                            out.append(_item(f"site|{x['id']}", x.get("displayName") or x.get("name") or x.get("webUrl", ""), True, kind="site",
                                             modified=_ts(x.get("lastModifiedDateTime"))))
                except CloudError:
                    continue  # account personale: niente SharePoint
            return sorted(out, key=lambda i: i["name"].lower())
        if fid.startswith("site|"):
            return [_item(f"d|{x['id']}|root", x.get("name", t("srv_cloud.documenti")), True, kind="drive", modified=_ts(x.get("lastModifiedDateTime")))
                    for x in self._pages(s, f"{self.API}/sites/{fid[5:]}/drives")]
        d, i = self._ids(fid)
        return self._pages(s, f"{self.API}/drives/{d}/items/{i}/children", {"$top": "999"}, self._map)

    def search(self, s, q, fid):
        qq = quote(q.replace("'", "''"), safe="")
        if fid and fid.startswith("d|"):
            d, i = self._ids(fid)
            url = f"{self.API}/drives/{d}/items/{i}/search(q='{qq}')"
        else:
            url = f"{self.API}/me/drive/root/search(q='{qq}')"
        return self._pages(s, url, mapper=self._map, limit=500)

    def meta(self, s, iid):
        d, i = self._ids(iid)
        x = s.call("GET", f"{self.API}/drives/{d}/items/{i}")
        m = self._map(x)
        par = x.get("parentReference") or {}
        m.update(version=x.get("cTag") or x.get("eTag"), autore=m.pop("by", ""), download=x.get("@microsoft.graph.downloadUrl"),
                 parent=f"d|{d}|{par['id']}" if par.get("id") else None, web=x.get("webUrl"))
        return m

    def download(self, s, iid, f, update):
        m = self.meta(s, iid)
        if not m.get("download"):
            raise CloudError(t("srv_cloud.onedrive_non_fornisce_contenuto_questo"))
        s.call("GET", m["download"], auth=False, out=f, update=update, total=m["size"])
        return m

    def _session_upload(self, s, url, src, size, headers, body, update):
        st, _, b = s.call("POST", url, headers=headers, js=body, raw=True)
        if st == 412:
            raise Conflict(None)
        if st == 409:
            raise Exists()
        if st not in (200, 201):
            raise _status_error(self.nome, st, b)
        up = _jsonb(b)["uploadUrl"]
        pos, last = 0, None
        while pos < size:
            n = min(self.CHUNK, size - pos)
            st, _, b = _put_file(s, up, src, pos, n, {"Content-Range": f"bytes {pos}-{pos + n - 1}/{size}"}, update, size, pos)
            if st not in (200, 201, 202):
                if st == 409:
                    raise Exists()
                raise _status_error(self.nome, st, b)
            pos += n
            last = b
        return _jsonb(last)

    def upload_version(self, s, iid, src, version, force, update):
        d, i = self._ids(iid)
        size = src.stat().st_size
        h = {} if force or not version else {"If-Match": version}
        try:
            if size <= self.SMALL:
                st, _, b = _put_file(s, f"{self.API}/drives/{d}/items/{i}/content", src, 0, size,
                                     {**h, "Content-Type": "application/octet-stream"}, update, size, auth=True)
                if st == 412:
                    raise Conflict(None)
                if st not in (200, 201):
                    raise _status_error(self.nome, st, b)
            else:
                self._session_upload(s, f"{self.API}/drives/{d}/items/{i}/createUploadSession", src, size, h,
                                     {"item": {"@microsoft.graph.conflictBehavior": "replace"}}, update)
        except Conflict:
            raise Conflict(self.meta(s, iid)) from None
        return self.meta(s, iid)

    def upload_new(self, s, fid, name, src, replace, update):
        d, i = self._ids(fid)
        size = src.stat().st_size
        beh = "replace" if replace else "fail"
        base = f"{self.API}/drives/{d}/items/{i}:/{quote(name, safe='')}:"
        if size <= self.SMALL:
            st, _, b = _put_file(s, f"{base}/content?@microsoft.graph.conflictBehavior={beh}", src, 0, size,
                                 {"Content-Type": "application/octet-stream"}, update, size, auth=True)
            if st == 409:
                raise Exists()
            if st not in (200, 201):
                raise _status_error(self.nome, st, b)
            x = _jsonb(b)
        else:
            x = self._session_upload(s, f"{base}/createUploadSession", src, size, {}, {"item": {"@microsoft.graph.conflictBehavior": beh}}, update)
        return self.meta(s, f"d|{d}|{x['id']}")


# ---- Google Drive
class GDrive(Provider):
    key, nome = "gdrive", "Google Drive"
    needs_secret = True
    API = "https://www.googleapis.com/drive/v3"
    UPL = "https://www.googleapis.com/upload/drive/v3"
    AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
    TOKEN = "https://oauth2.googleapis.com/token"
    REVOKE = "https://oauth2.googleapis.com/revoke"
    SCOPES = "https://www.googleapis.com/auth/drive openid email profile"
    FOLDER = "application/vnd.google-apps.folder"
    FIELDS = ("id,name,mimeType,size,modifiedTime,version,headRevisionId,md5Checksum,parents,webViewLink,"
              "lastModifyingUser(displayName),shortcutDetails(targetId,targetMimeType)")
    # documenti nativi di Google: si aprono come copia Office (esportazione); il salvataggio crea un file nuovo
    EXPORT = {"application/vnd.google-apps.document": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
              "application/vnd.google-apps.spreadsheet": ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
              "application/vnd.google-apps.presentation": ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
              "application/vnd.google-apps.drawing": ("pdf", "application/pdf")}
    COMMON = {"supportsAllDrives": "true"}

    def redirect(self, port):
        return f"http://127.0.0.1:{port}/"  # client "App desktop": loopback senza registrazione dell'indirizzo

    def authorize(self, c):
        return self.AUTH, {"scope": self.SCOPES, "access_type": "offline", "prompt": "consent"}

    def token_url(self, c):
        return self.TOKEN

    def token_extra(self, c):
        return {"client_secret": c.get("client_secret", "")}

    def revoke(self, c, tok):
        _http("POST", self.REVOKE, {"Content-Type": "application/x-www-form-urlencoded"},
              urlencode({"token": tok.get("refresh_token") or tok.get("access_token")}).encode(), timeout=10)

    def account(self, s):
        u = s.call("GET", self.API + "/about", params={"fields": "user(displayName,emailAddress)"}).get("user", {})
        return {"nome": u.get("displayName", ""), "email": u.get("emailAddress", "")}

    def _map(self, x):
        mime, fid = x.get("mimeType", ""), x["id"]
        if mime == "application/vnd.google-apps.shortcut" and x.get("shortcutDetails"):
            mime, fid = x["shortcutDetails"].get("targetMimeType", ""), x["shortcutDetails"]["targetId"]
        name = x.get("name", "")
        native = mime in self.EXPORT
        if native:
            name += "." + self.EXPORT[mime][0]
        elif mime.startswith("application/vnd.google-apps.") and mime != self.FOLDER:
            return None  # moduli, siti, mappe: non scaricabili
        return _item(fid, name, mime == self.FOLDER, int(x.get("size") or 0), _ts(x.get("modifiedTime")),
                     by=(x.get("lastModifyingUser") or {}).get("displayName", ""), native=native or None)

    def _files(self, s, q, limit=5000):
        out, tok = [], None
        while len(out) < limit:
            p = {"q": q, "fields": f"nextPageToken,files({self.FIELDS})", "pageSize": "1000", "includeItemsFromAllDrives": "true", **self.COMMON}
            if tok:
                p["pageToken"] = tok
            j = s.call("GET", self.API + "/files", params=p)
            out += [m for m in map(self._map, j.get("files", [])) if m]
            tok = j.get("nextPageToken")
            if not tok:
                break
        return sorted(out, key=lambda i: (not i["dir"], i["name"].lower()))

    def roots(self, s):
        return [_item("root", t("srv_cloud.mio_drive"), True, kind="drive"), _item("shared", t("srv_cloud.condivisi_me"), True, kind="shared"),
                _item("drives", t("srv_cloud.drive_condivisi"), True, kind="sites")]

    @staticmethod
    def _esc(v):
        return v.replace("\\", "\\\\").replace("'", "\\'")

    def list(self, s, fid):
        if fid == "drives":
            out, tok = [], None
            while True:
                p = {"pageSize": "100", **({"pageToken": tok} if tok else {})}
                j = s.call("GET", self.API + "/drives", params=p)
                out += [_item(d["id"], d.get("name", ""), True, kind="drive") for d in j.get("drives", [])]
                tok = j.get("nextPageToken")
                if not tok:
                    return out
        if fid == "shared":
            return self._files(s, "sharedWithMe and trashed = false")
        return self._files(s, f"'{self._esc(fid)}' in parents and trashed = false")

    def search(self, s, q, fid):
        return self._files(s, f"name contains '{self._esc(q)}' and trashed = false", limit=500)

    def meta(self, s, iid):
        x = s.call("GET", f"{self.API}/files/{iid}", params={"fields": self.FIELDS, **self.COMMON})
        m = self._map(x) or _item(iid, x.get("name", ""))
        m.update(version=x.get("headRevisionId") or x.get("md5Checksum") or str(x.get("version", "")), autore=m.pop("by", ""),
                 parent=(x.get("parents") or [None])[0], mime=x.get("mimeType"), web=x.get("webViewLink"))
        return m

    def download(self, s, iid, f, update):
        m = self.meta(s, iid)
        if m.get("native"):
            s.call("GET", f"{self.API}/files/{iid}/export", params={"mimeType": self.EXPORT[m["mime"]][1]}, out=f, update=update)
        else:
            s.call("GET", f"{self.API}/files/{iid}", params={"alt": "media", **self.COMMON}, out=f, update=update, total=m["size"])
        return m

    def _resumable(self, s, method, url, meta, src, update):
        size = src.stat().st_size
        st, hd, b = s.call(method, url, js=meta, headers={"X-Upload-Content-Length": str(size), "X-Upload-Content-Type": "application/octet-stream"},
                           ctype="application/json; charset=UTF-8", raw=True)
        if st != 200 or not hd.get("Location"):
            raise _status_error(self.nome, st, b)
        loc = hd["Location"]
        pos, chunk, b = 0, 32 * 256 * 1024, b""
        while pos < size or size == 0:
            n = min(chunk, size - pos)
            rng = f"bytes {pos}-{pos + n - 1}/{size}" if size else "bytes */0"
            st, _, b = _put_file(s, loc, src, pos, n, {"Content-Range": rng}, update, size, pos)
            if st not in (200, 201, 308):
                raise _status_error(self.nome, st, b)
            pos += n
            if size == 0:
                break
        return _jsonb(b)

    def upload_version(self, s, iid, src, version, force, update):
        m = self.meta(s, iid)
        if m.get("native"):
            raise CloudError(t("srv_cloud.i_documenti_google_non_si"))
        if not force and version and m["version"] != version:
            raise Conflict(m)
        self._resumable(s, "PATCH", f"{self.UPL}/files/{iid}?uploadType=resumable&supportsAllDrives=true", {}, src, update)
        return self.meta(s, iid)

    def upload_new(self, s, fid, name, src, replace, update):
        if fid in ("shared", "drives"):
            raise CloudError(t("srv_cloud.scegli_cartella_destinazione"))
        same = [x for x in self._files(s, f"name = '{self._esc(name)}' and '{self._esc(fid)}' in parents and trashed = false", 10)
                if not x["dir"] and not x.get("native")]
        if same:
            if not replace:
                raise Exists()
            return self.upload_version(s, same[0]["id"], src, None, True, update)
        x = self._resumable(s, "POST", f"{self.UPL}/files?uploadType=resumable&supportsAllDrives=true", {"name": name, "parents": [fid]}, src, update)
        return self.meta(s, x["id"])


# ---- Dropbox
class Dropbox(Provider):
    key, nome = "dropbox", "Dropbox"
    API = "https://api.dropboxapi.com/2"
    CONTENT = "https://content.dropboxapi.com/2"
    AUTH = "https://www.dropbox.com/oauth2/authorize"
    TOKEN = "https://api.dropboxapi.com/oauth2/token"
    SCOPES = "account_info.read files.metadata.read files.content.read files.content.write sharing.write"  # sharing.write: link degli invii grandi (mbvisual/mail/bigfile.py)
    SMALL = 140 * 1024 * 1024
    CHUNK = 32 * 1024 * 1024

    def authorize(self, c):
        return self.AUTH, {"scope": self.SCOPES, "token_access_type": "offline"}

    def token_url(self, c):
        return self.TOKEN

    def revoke(self, c, tok):
        _http("POST", self.API + "/auth/token/revoke", {"Authorization": "Bearer " + tok.get("access_token", "")}, None, timeout=10)

    def account(self, s):
        a = s.call("POST", self.API + "/users/get_current_account", data=b"null", headers={"Content-Type": "application/json"})
        return {"nome": (a.get("name") or {}).get("display_name", ""), "email": a.get("email", "")}

    @staticmethod
    def _arg(d):
        return json.dumps(d, ensure_ascii=True)  # Dropbox-API-Arg: JSON con soli caratteri ASCII

    def _map(self, x):
        folder = x.get(".tag") == "folder"
        return _item(x.get("path_lower") or x.get("id"), x.get("name", ""), folder, x.get("size", 0),
                     _ts(x.get("server_modified")), display=x.get("path_display"))

    def roots(self, s):
        return self.list(s, "")

    def list(self, s, fid):
        j = s.call("POST", self.API + "/files/list_folder", js={"path": fid or "", "limit": 2000})
        out = [self._map(x) for x in j.get("entries", []) if x.get(".tag") in ("file", "folder")]
        while j.get("has_more") and len(out) < 20000:
            j = s.call("POST", self.API + "/files/list_folder/continue", js={"cursor": j["cursor"]})
            out += [self._map(x) for x in j.get("entries", []) if x.get(".tag") in ("file", "folder")]
        return sorted(out, key=lambda i: (not i["dir"], i["name"].lower()))

    def search(self, s, q, fid):
        j = s.call("POST", self.API + "/files/search_v2", js={"query": q, "options": {"path": fid or "", "max_results": 200, "file_status": "active"}})
        return [self._map(m["metadata"]["metadata"]) for m in j.get("matches", []) if m.get("metadata", {}).get("metadata")]

    def meta(self, s, iid):
        x = s.call("POST", self.API + "/files/get_metadata", js={"path": iid})
        m = self._map(x)
        par = (x.get("path_lower") or "").rsplit("/", 1)[0]
        m.update(version=x.get("rev"), autore="", parent=par)
        return m

    def download(self, s, iid, f, update):
        m = self.meta(s, iid)
        s.call("POST", self.CONTENT + "/files/download", headers={"Dropbox-API-Arg": self._arg({"path": iid})}, out=f, update=update, total=m["size"])
        return m

    def _upload(self, s, path, src, mode, update):
        size = src.stat().st_size
        commit = {"path": path, "mode": mode, "autorename": False, "mute": True, "strict_conflict": True}
        oct_ = {"Content-Type": "application/octet-stream"}
        if size <= self.SMALL:
            st, _, b = _put_file(s, self.CONTENT + "/files/upload", src, 0, size, {**oct_, "Dropbox-API-Arg": self._arg(commit)},
                                 update, size, auth=True, method="POST")
        else:
            st, _, b = _put_file(s, self.CONTENT + "/files/upload_session/start", src, 0, self.CHUNK,
                                 {**oct_, "Dropbox-API-Arg": self._arg({"close": False})}, update, size, auth=True, method="POST")
            if st != 200:
                raise _status_error(self.nome, st, b)
            sid, pos = _jsonb(b)["session_id"], self.CHUNK
            while size - pos > self.CHUNK:
                st, _, b = _put_file(s, self.CONTENT + "/files/upload_session/append_v2", src, pos, self.CHUNK,
                                     {**oct_, "Dropbox-API-Arg": self._arg({"cursor": {"session_id": sid, "offset": pos}, "close": False})},
                                     update, size, pos, auth=True, method="POST")
                if st != 200:
                    raise _status_error(self.nome, st, b)
                pos += self.CHUNK
            st, _, b = _put_file(s, self.CONTENT + "/files/upload_session/finish", src, pos, size - pos,
                                 {**oct_, "Dropbox-API-Arg": self._arg({"cursor": {"session_id": sid, "offset": pos}, "commit": commit})},
                                 update, size, pos, auth=True, method="POST")
        if st == 409 and "conflict" in _err_text(b):
            raise Conflict(None)
        if st != 200:
            raise _status_error(self.nome, st, b)
        return _jsonb(b)

    def upload_version(self, s, iid, src, version, force, update):
        mode = "overwrite" if force or not version else {".tag": "update", "update": version}
        try:
            x = self._upload(s, iid, src, mode, update)
        except Conflict:
            raise Conflict(self.meta(s, iid)) from None
        return self.meta(s, x.get("path_lower") or iid)

    def upload_new(self, s, fid, name, src, replace, update):
        try:
            x = self._upload(s, f"{fid or ''}/{name}", src, "overwrite" if replace else "add", update)
        except Conflict:
            raise Exists() from None
        return self.meta(s, x["path_lower"])


# ---- Autodesk Construction Cloud / BIM 360 / Docs (APS Data Management)
class Autodesk(Provider):
    key, nome = "autodesk", "Autodesk Construction Cloud / BIM 360"
    can_search_root = False
    BASE = "https://developer.api.autodesk.com"
    USER = "https://api.userprofile.autodesk.com/userinfo"
    SCOPES = "data:read data:write data:create user-profile:read"
    JSONAPI = "application/vnd.api+json"
    PART = 50 * 1024 * 1024

    def authorize(self, c):
        return self.BASE + "/authentication/v2/authorize", {"scope": self.SCOPES}

    def token_url(self, c):
        return self.BASE + "/authentication/v2/token"

    def revoke(self, c, tok):
        if tok.get("refresh_token"):
            _http("POST", self.BASE + "/authentication/v2/revoke", {"Content-Type": "application/x-www-form-urlencoded"},
                  urlencode({"token": tok["refresh_token"], "token_type_hint": "refresh_token", "client_id": c.get("client_id", "")}).encode(), timeout=10)

    def account(self, s):
        u = s.call("GET", self.USER)
        return {"nome": u.get("name") or u.get("preferred_username") or "", "email": u.get("email", "")}

    def _pages(self, s, url):
        data, inc = [], []
        while url and len(data) < 10000:
            j = s.call("GET", url)
            data += j.get("data") or []
            inc += j.get("included") or []
            url = ((j.get("links") or {}).get("next") or {}).get("href")
        return data, inc

    def roots(self, s):
        data, _ = self._pages(s, self.BASE + "/project/v1/hubs")
        return [_item(f"hub|{h['id']}", h["attributes"].get("name", ""), True, kind="hub") for h in data]

    def _ver(self, v):
        a = v.get("attributes") or {}
        return a.get("storageSize") or 0, _ts(a.get("lastModifiedTime")), a.get("lastModifiedUserName", "")

    def list(self, s, fid):
        kind, rest = fid.split("|", 1)
        if kind == "hub":
            data, _ = self._pages(s, f"{self.BASE}/project/v1/hubs/{quote(rest, safe='')}/projects")
            return sorted((_item(f"proj|{rest}|{p['id']}", p["attributes"].get("name", ""), True, kind="project") for p in data),
                          key=lambda i: i["name"].lower())
        if kind == "proj":
            hub, proj = rest.split("|", 1)
            data, _ = self._pages(s, f"{self.BASE}/project/v1/hubs/{quote(hub, safe='')}/projects/{quote(proj, safe='')}/topFolders")
            return [_item(f"fold|{proj}|{f['id']}", f["attributes"].get("displayName") or f["attributes"].get("name", ""), True)
                    for f in data if not f["attributes"].get("hidden")]
        if kind == "fold":
            proj, folder = rest.split("|", 1)
            data, inc = self._pages(s, f"{self.BASE}/data/v1/projects/{quote(proj, safe='')}/folders/{quote(folder, safe='')}/contents")
            vers = {v["id"]: v for v in inc if v.get("type") == "versions"}
            out = []
            for x in data:
                a = x.get("attributes") or {}
                if a.get("hidden"):
                    continue
                if x["type"] == "folders":
                    out.append(_item(f"fold|{proj}|{x['id']}", a.get("displayName") or a.get("name", ""), True, modified=_ts(a.get("lastModifiedTime"))))
                elif x["type"] == "items":
                    tip = vers.get(((x.get("relationships") or {}).get("tip") or {}).get("data", {}).get("id"), {})
                    size, mod, by = self._ver(tip)
                    out.append(_item(f"item|{proj}|{x['id']}", a.get("displayName", ""), False, size, mod or _ts(a.get("lastModifiedTime")), by=by))
            return sorted(out, key=lambda i: (not i["dir"], i["name"].lower()))
        raise CloudError(t("srv_cloud.elemento_autodesk_non_valido"))

    def search(self, s, q, fid):
        if not fid or not fid.startswith("fold|"):
            raise CloudError(t("srv_cloud.apri_progetto_sua_cartella_cercare"))
        proj, folder = fid[5:].split("|", 1)
        url = (f"{self.BASE}/data/v1/projects/{quote(proj, safe='')}/folders/{quote(folder, safe='')}/search?"
               + urlencode({"filter[attributes.displayName]-contains": q}))
        data, _ = self._pages(s, url)
        out, seen = [], set()
        for v in data:
            item = (((v.get("relationships") or {}).get("item") or {}).get("data") or {}).get("id")
            if not item or item in seen:
                continue
            seen.add(item)
            size, mod, by = self._ver(v)
            out.append(_item(f"item|{proj}|{item}", (v.get("attributes") or {}).get("displayName", ""), False, size, mod, by=by))
        return out

    def _ids(self, iid):
        kind, proj, rid = iid.split("|", 2)
        return kind, proj, rid

    def meta(self, s, iid):
        _, proj, item = self._ids(iid)
        j = s.call("GET", f"{self.BASE}/data/v1/projects/{quote(proj, safe='')}/items/{quote(item, safe='')}")
        x = j["data"]
        tipid = x["relationships"]["tip"]["data"]["id"]
        tip = next((v for v in j.get("included") or [] if v.get("id") == tipid), {})
        size, mod, by = self._ver(tip)
        par = x["relationships"].get("parent", {}).get("data", {}).get("id")
        storage = (((tip.get("relationships") or {}).get("storage") or {}).get("data") or {}).get("id")
        return _item(iid, x["attributes"].get("displayName", ""), False, size, mod, version=tipid, autore=by,
                     parent=f"fold|{proj}|{par}" if par else None, storage=storage,
                     web=((x.get("links") or {}).get("webView") or {}).get("href"))

    @staticmethod
    def _obj(storage):
        # urn:adsk.objects:os.object:wip.dm.prod/abc.dwg -> (bucket, chiave)
        b, _, k = storage.split("os.object:", 1)[1].partition("/")
        return quote(b, safe=""), quote(k, safe="")

    def download(self, s, iid, f, update):
        m = self.meta(s, iid)
        if not m.get("storage"):
            raise CloudError(t("srv_cloud.questo_elemento_autodesk_non_ha"))
        b, k = self._obj(m["storage"])
        j = s.call("GET", f"{self.BASE}/oss/v2/buckets/{b}/objects/{k}/signeds3download")
        url = j.get("url") or (j.get("urls") or [None])[0]
        if not url:
            raise CloudError(t("srv_cloud.autodesk_non_ha_fornito_l"))
        s.call("GET", url, auth=False, out=f, update=update, total=m["size"])
        return m

    def _types(self, proj):
        fam = "autodesk.bim360" if proj.startswith("b.") else "autodesk.core"
        return f"items:{fam}:File", f"versions:{fam}:File"

    def _store(self, s, proj, folder, name, src, update):
        j = s.call("POST", f"{self.BASE}/data/v1/projects/{quote(proj, safe='')}/storage", ctype=self.JSONAPI, js={
            "jsonapi": {"version": "1.0"},
            "data": {"type": "objects", "attributes": {"name": name},
                     "relationships": {"target": {"data": {"type": "folders", "id": folder}}}}})
        storage = j["data"]["id"]
        b, k = self._obj(storage)
        size = src.stat().st_size
        parts = max(1, math.ceil(size / self.PART))
        key, urls, first = None, [], 1
        while first <= parts:  # al massimo 25 indirizzi per richiesta
            n = min(25, parts - first + 1)
            p = {"parts": n, "firstPart": first, **({"uploadKey": key} if key else {})}
            j = s.call("GET", f"{self.BASE}/oss/v2/buckets/{b}/objects/{k}/signeds3upload", params=p)
            key = j["uploadKey"]
            urls += j["urls"]
            first += n
        for idx, url in enumerate(urls):
            pos = idx * self.PART
            st, _, body = _put_file(s, url, src, pos, min(self.PART, size - pos), {"Content-Type": "application/octet-stream"}, update, size, pos)
            if st not in (200, 201):
                raise _status_error(self.nome, st, body)
        s.call("POST", f"{self.BASE}/oss/v2/buckets/{b}/objects/{k}/signeds3upload", js={"uploadKey": key})
        return storage

    def upload_version(self, s, iid, src, version, force, update):
        m = self.meta(s, iid)
        if not force and version and m["version"] != version:
            raise Conflict(m)
        _, proj, item = self._ids(iid)
        folder = m["parent"].split("|", 2)[2]
        storage = self._store(s, proj, folder, m["name"], src, update)
        _, vtype = self._types(proj)
        s.call("POST", f"{self.BASE}/data/v1/projects/{quote(proj, safe='')}/versions", ctype=self.JSONAPI, js={
            "jsonapi": {"version": "1.0"},
            "data": {"type": "versions", "attributes": {"name": m["name"], "extension": {"type": vtype, "version": "1.0"}},
                     "relationships": {"item": {"data": {"type": "items", "id": item}},
                                       "storage": {"data": {"type": "objects", "id": storage}}}}})
        return self.meta(s, iid)

    def upload_new(self, s, fid, name, src, replace, update):
        if not fid.startswith("fold|"):
            raise CloudError(t("srv_cloud.scegli_cartella_progetto_autodesk"))
        same = [x for x in self.list(s, fid) if not x["dir"] and x["name"].lower() == name.lower()]
        if same:
            if not replace:
                raise Exists()
            return self.upload_version(s, same[0]["id"], src, None, True, update)
        proj, folder = fid[5:].split("|", 1)
        storage = self._store(s, proj, folder, name, src, update)
        itype, vtype = self._types(proj)
        j = s.call("POST", f"{self.BASE}/data/v1/projects/{quote(proj, safe='')}/items", ctype=self.JSONAPI, js={
            "jsonapi": {"version": "1.0"},
            "data": {"type": "items", "attributes": {"displayName": name, "extension": {"type": itype, "version": "1.0"}},
                     "relationships": {"tip": {"data": {"type": "versions", "id": "1"}},
                                       "parent": {"data": {"type": "folders", "id": folder}}}},
            "included": [{"type": "versions", "id": "1", "attributes": {"name": name, "extension": {"type": vtype, "version": "1.0"}},
                          "relationships": {"storage": {"data": {"type": "objects", "id": storage}}}}]})
        return self.meta(s, f"item|{proj}|{j['data']['id']}")


PROVIDERS = {p.key: p for p in (Graph(), GDrive(), Dropbox(), Autodesk())}


# ------------------------------------------------------------------ accesso OAuth 2.0 + PKCE
_PENDING: dict[str, dict] = {}   # state -> accesso in corso
_LISTENERS: list = []
_PAGE = """<!doctype html><html lang="it"><meta charset="utf-8"><title>MB Visual</title>
<style>body{font:15px Segoe UI,system-ui,sans-serif;background:#f3f4f6;color:#1f2937;display:grid;place-items:center;height:100vh;margin:0;cursor:default}
div{background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:28px 36px;max-width:440px;text-align:center}
h1{font-size:19px;margin:0 0 10px;color:%s}</style><div><h1>%s</h1><p>%s</p></div>
<script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script></html>"""


class _CallbackHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        login = _PENDING.get(q.get("state", ""))
        if not login:
            ok, title, text = False, t("srv_cloud.richiesta_non_riconosciuta"), t("srv_cloud.questa_pagina_accesso_scaduta_non")
            if u.path in ("/favicon.ico",):
                self.send_response(404)
                self.end_headers()
                return
        elif q.get("error"):
            login["error"] = q.get("error_description") or q["error"]
            login["denied"] = q["error"] == "access_denied"
            ok, title, text = False, t("srv_cloud.accesso_non_completato"), (t("srv_cloud.hai_negato_l_autorizzazione") if login["denied"] else login["error"]) + t("srv_cloud.puoi_chiudere_questa_scheda")
            login["event"].set()
        elif q.get("code"):
            login["code"] = q["code"]
            ok, title, text = True, t("srv_cloud.accesso_completato"), t("srv_cloud.puoi_chiudere_questa_scheda_tornare")
            login["event"].set()
        else:
            ok, title, text = False, t("srv_cloud.risposta_incompleta"), t("srv_cloud.servizio_non_ha_restituito_codice")
        body = (_PAGE % ("#047857" if ok else "#b91c1c", title, text)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class _Server(ThreadingHTTPServer):
    # niente SO_REUSEADDR: su Windows permetterebbe a un altro programma di agganciarsi alla stessa porta
    allow_reuse_address = False
    allow_reuse_port = False
    daemon_threads = True


class _V6Server(_Server):
    import socket as _s
    address_family = _s.AF_INET6


def _start_listener(port: int):
    with _LOCK:
        if _LISTENERS:
            return
        servers = []
        try:
            servers.append(_Server(("127.0.0.1", port), _CallbackHandler))
        except OSError as e:
            raise CloudError(t("srv_cloud.porta_occupata", port)) from e
        try:  # "localhost" nel browser puo' risolversi in ::1
            servers.append(_V6Server(("::1", port), _CallbackHandler))
        except OSError:
            pass
        for srv in servers:
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        _LISTENERS.extend(servers)


def _stop_listener():
    with _LOCK:
        if _PENDING:
            return
        for srv in _LISTENERS:
            srv.shutdown()
            srv.server_close()
        _LISTENERS.clear()


def login_start(svc: str, open_browser=True) -> dict:
    if svc not in PROVIDERS:
        raise CloudError(t("srv_cloud.servizio_sconosciuto"))
    cfg = config()
    if not configured(svc, cfg):
        raise CloudError(t("srv_cloud.0_non_configurato_inserisci_l", PROVIDERS[svc].nome))
    for st_, l in list(_PENDING.items()):  # un solo accesso alla volta per servizio
        if l["svc"] == svc:
            l["cancel"] = True
            l["event"].set()
    prov, c, port = PROVIDERS[svc], cfg[svc], cfg["_port"]
    _start_listener(port)
    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(24)
    redirect = prov.redirect(port)
    url, extra = prov.authorize(c)
    params = {"client_id": c["client_id"], "response_type": "code", "redirect_uri": redirect, "state": state,
              "code_challenge": challenge, "code_challenge_method": "S256", **extra}
    auth_url = url + "?" + urlencode(params)
    login = {"svc": svc, "verifier": verifier, "redirect": redirect, "event": threading.Event(), "cancel": False, "url": auth_url}
    _PENDING[state] = login
    job = jobs.start(_login_wait, state)
    if open_browser:
        webbrowser.open(auth_url)
    return {"ok": True, "job": job, "url": auth_url, "redirect": redirect}


def _login_wait(state, update):
    login = _PENDING[state]
    svc = login["svc"]
    prov = PROVIDERS[svc]
    try:
        update(0.1, t("srv_cloud.attesa_dell_accesso_browser"))
        if not login["event"].wait(LOGIN_TIMEOUT):
            raise CloudError(t("srv_cloud.tempo_scaduto_l_accesso_browser"))
        if login["cancel"]:
            raise CloudError(t("srv_cloud.accesso_annullato"))
        if login.get("error"):
            raise CloudError(t("srv_cloud.accesso_negato") if login.get("denied") else t("srv_cloud.accesso_non_riuscito_0", login['error']))
        update(0.6, t("srv_cloud.verifica_dell_accesso"))
        c = config()[svc]
        form = {"grant_type": "authorization_code", "code": login["code"], "redirect_uri": login["redirect"],
                "client_id": c["client_id"], "code_verifier": login["verifier"], **prov.token_extra(c)}
        st, _, body = _http("POST", prov.token_url(c), {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
                            urlencode(form).encode())
        if st != 200:
            raise CloudError(t("srv_cloud.accesso_rifiutato", prov.nome, _err_text(body) or st))
        j = _jsonb(body)
        tok = {"access_token": j["access_token"], "refresh_token": j.get("refresh_token"),
               "expires_at": time.time() + int(j.get("expires_in") or 3600)}
        with _LOCK:
            toks = _tokens()
            toks[svc] = tok
            _save_tokens(toks)
        try:
            acc = prov.account(Session(svc))
        except CloudError:
            acc = {"nome": "", "email": ""}
        with _LOCK:
            toks = _tokens()
            if svc in toks:
                toks[svc]["account"] = acc
                _save_tokens(toks)
        return {"servizio": svc, "account": acc}
    finally:
        _PENDING.pop(state, None)
        _stop_listener()


def login_cancel(svc: str):
    for l in list(_PENDING.values()):
        if not svc or l["svc"] == svc:
            l["cancel"] = True
            l["event"].set()
    return {"ok": True}


def logout(svc: str):
    with _LOCK:
        toks = _tokens()
        tok = toks.pop(svc, None)
        _save_tokens(toks)
    if tok:
        try:
            PROVIDERS[svc].revoke(config().get(svc, {}), tok)
        except Exception:  # noqa: BLE001 - la revoca e' solo una cortesia: il token locale e' gia' cancellato
            pass
    return {"ok": True}


def status() -> dict:
    cfg, toks = config(), _tokens()
    out = []
    for k, p in PROVIDERS.items():
        out.append({"id": k, "nome": p.nome, "configurato": configured(k, cfg), "connesso": k in toks,
                    "account": (toks.get(k) or {}).get("account"), "cerca_radice": p.can_search_root})
    return {"ok": True, "servizi": out, "porta": cfg["_port"], "guida": str(GUIDE)}


def config_view() -> dict:
    cfg = config()
    return {"ok": True, "porta": cfg["_port"], "servizi": {k: {"client_id": cfg[k].get("client_id", ""), "tenant": cfg[k].get("tenant", ""),
            "segreto": bool(cfg[k].get("client_secret")), "redirect": p.redirect(cfg["_port"]), "nome": p.nome, "serve_segreto": p.needs_secret}
            for k, p in PROVIDERS.items()}}


# ------------------------------------------------------------------ file aperti dal cloud
_ENTRIES: dict[str, dict] = {}
_ENTRIES_FILE = CACHE / "aperti.json"
_loaded = False


def _load_entries():
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        for e in json.loads(_ENTRIES_FILE.read_text("utf-8")):
            if Path(e["path"]).exists():
                e.pop("uploading", None)
                _ENTRIES[e["path"]] = e
    except (OSError, ValueError, KeyError):
        pass
    _cleanup()


def _save_entries():
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        _ENTRIES_FILE.write_text(json.dumps([{k: v for k, v in e.items() if k != "uploading"} for e in _ENTRIES.values()]), "utf-8")
    except OSError:
        pass


def _cleanup():
    """Copie scaricate piu' vecchie di 14 giorni e gia' caricate: si tolgono (la cache non cresce all'infinito)."""
    lim = time.time() - 14 * 86400
    for path, e in list(_ENTRIES.items()):
        try:
            st = os.stat(path)
            if st.st_mtime < lim and not _local_changed(e, st):
                os.remove(path)
                _ENTRIES.pop(path, None)
        except OSError:
            _ENTRIES.pop(path, None)


def _safe(name: str) -> str:
    n = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "file"
    return n[:180]


def _local_changed(e, st=None) -> bool:
    try:
        st = st or os.stat(e["path"])
    except OSError:
        return False
    return (st.st_mtime_ns, st.st_size) != (e.get("mtime"), e.get("size"))


def _mark_synced(e):
    st = os.stat(e["path"])
    e["mtime"], e["size"] = st.st_mtime_ns, st.st_size
    e.pop("skip", None)


def _entry(path) -> dict:
    _load_entries()
    e = _ENTRIES.get(os.path.abspath(path))
    if not e:
        raise CloudError(t("srv_cloud.questo_file_non_stato_aperto"))
    return e


def _download_to(sess, prov, iid, dest: Path, update):
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".mbv-part")
    with open(part, "wb") as f:
        m = prov.download(sess, iid, f, update)
    try:
        os.replace(part, dest)
    except PermissionError:
        part.unlink(missing_ok=True)
        raise CloudError(t("srv_cloud.0_aperto_altro_programma_chiudilo", dest.name)) from None
    return m


def open_item(svc, iid, update):
    _load_entries()
    prov, sess = PROVIDERS[svc], Session(svc)
    update(0.02, t("srv_cloud.lettura_informazioni"))
    m = prov.meta(sess, iid)
    if m.get("dir"):
        raise CloudError(t("srv_cloud.cartella"))
    key = hashlib.sha1(f"{svc}|{iid}".encode()).hexdigest()[:16]
    path = CACHE / svc / key / _safe(m["name"])
    sp = str(path)
    e = _ENTRIES.get(sp)
    if e and path.exists():
        if _local_changed(e):  # modifiche locali non ancora caricate: restano, l'interfaccia le carichera'
            return {"path": sp, "locale": True}
        if e.get("version") == m.get("version"):
            return {"path": sp}
    m = _download_to(sess, prov, iid, path, update)
    e = {"path": sp, "svc": svc, "id": iid, "nome": m["name"], "parent": m.get("parent"), "version": m.get("version"),
         "native": bool(m.get("native")), "web": m.get("web")}
    _mark_synced(e)
    _ENTRIES[sp] = e
    _save_entries()
    return {"path": sp}


def pending() -> dict:
    """File aperti dal cloud salvati sul PC e non ancora caricati (fermi da almeno 1,5 s)."""
    _load_entries()
    out, now = [], time.time()
    for e in _ENTRIES.values():
        try:
            st = os.stat(e["path"])
        except OSError:
            continue
        if e.get("uploading") or not _local_changed(e, st) or now - st.st_mtime < 1.5 or e.get("skip") == st.st_mtime_ns:
            continue
        out.append({"path": e["path"], "nome": e["nome"], "servizio": e["svc"], "native": e.get("native")})
    return {"ok": True, "files": out}


def opened() -> dict:
    _load_entries()
    out = []
    for e in _ENTRIES.values():
        try:
            st = os.stat(e["path"])
        except OSError:
            continue
        stato = "caricamento" if e.get("uploading") else ("da caricare" if _local_changed(e, st) else "sincronizzato")
        out.append({"path": e["path"], "nome": e["nome"], "servizio": e["svc"], "stato": stato, "web": e.get("web")})
    return {"ok": True, "files": out}


def upload(path, force, update):
    e = _entry(path)
    if e.get("uploading"):
        raise CloudError(t("srv_cloud.caricamento_gia_corso"))
    if e.get("native"):
        return {"nativo": True}
    prov, sess = PROVIDERS[e["svc"]], Session(e["svc"])
    e["uploading"] = True
    st0 = os.stat(path)
    try:
        update(0.02, t("srv_cloud.controllo_versione_cloud"))
        try:
            m = prov.upload_version(sess, e["id"], Path(path), None if force else e.get("version"), force, update)
        except Conflict as c:
            m = c.meta or {}
            return {"conflitto": True, "remoto": {"autore": m.get("autore", ""), "modificato": m.get("modified", 0), "nome": m.get("name", e["nome"])}}
        e["version"] = m.get("version")
        e["mtime"], e["size"] = st0.st_mtime_ns, st0.st_size  # se il file e' cambiato di nuovo nel frattempo resta "da caricare"
        e.pop("skip", None)
        return {"ok": True, "versione": e["version"]}
    finally:
        e.pop("uploading", None)
        _save_entries()


def _copy_name(name: str) -> str:
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    who = os.environ.get("USERNAME", "")
    when = f"{datetime.now():%Y-%m-%d %H.%M}"
    tag = t("srv_cloud.copia_di", who, when) if who else t("srv_cloud.copia", when)
    return stem + tag + ("." + ext if ext else "")


def upload_copy(path, update):
    """Salva le modifiche locali come file nuovo nella stessa cartella del cloud e collega la scheda a quel file."""
    e = _entry(path)
    prov, sess = PROVIDERS[e["svc"]], Session(e["svc"])
    if e.get("parent") is None:  # la radice di Dropbox e' ""
        raise CloudError(t("srv_cloud.cartella_origine_sconosciuta_usa_salva"))
    name = _copy_name(e["nome"])
    m = prov.upload_new(sess, e["parent"], name, Path(path), False, update)
    e.update(id=m["id"], nome=m["name"], version=m.get("version"), native=False, web=m.get("web"))
    _mark_synced(e)
    _save_entries()
    return {"ok": True, "nome": m["name"]}


def skip(path):
    e = _entry(path)
    e["skip"] = os.stat(path).st_mtime_ns
    _save_entries()
    return {"ok": True}


def check(path) -> dict:
    """La versione sul cloud e' cambiata rispetto a quella scaricata?"""
    e = _entry(path)
    m = PROVIDERS[e["svc"]].meta(Session(e["svc"]), e["id"])
    changed = m.get("version") != e.get("version")
    return {"ok": True, "cambiato": changed, "locale": _local_changed(e), "autore": m.get("autore", ""), "modificato": m.get("modified", 0)}


def refresh(path, update):
    """Riscarica la versione del cloud sopra la copia locale (la scheda si ricarica da sola)."""
    e = _entry(path)
    prov, sess = PROVIDERS[e["svc"]], Session(e["svc"])
    m = _download_to(sess, prov, e["id"], Path(path), update)
    e["version"] = m.get("version")
    _mark_synced(e)
    _save_entries()
    return {"ok": True}


def save_new(src, svc, folder, name, replace, update):
    """Salva con nome verso il cloud: carica `src` come file `name` nella cartella `folder`."""
    srcp = Path(src)
    if not srcp.is_file():
        raise CloudError(t("srv_cloud.file_caricare_non_trovato"))
    name = _safe(name)
    try:
        m = PROVIDERS[svc].upload_new(Session(svc), folder, name, srcp, replace, update)
    except Exists:
        return {"esiste": True, "nome": name}
    return {"ok": True, "nome": m["name"], "id": m["id"]}


# ------------------------------------------------------------------ ingresso dalle API del server (/api/cloud?op=...)
def _list(svc, fid):
    prov, s = PROVIDERS[svc], Session(svc)
    items = prov.roots(s) if not fid else prov.list(s, fid)
    return {"ok": True, "items": items}


def handle(op: str, q: dict, body: dict) -> dict:
    svc = q.get("svc") or body.get("svc") or ""
    if svc and svc not in PROVIDERS:
        raise CloudError(t("srv_cloud.servizio_sconosciuto"))
    try:
        if op == "stato":
            return status()
        if op == "config":
            return config_view()
        if op == "config_set":
            return set_config(body)
        if op == "guida":
            return {"ok": True, "path": str(GUIDE)}
        if op == "login":
            return login_start(svc, q.get("apri", "1") != "0")
        if op == "login_cancel":
            return login_cancel(svc)
        if op == "logout":
            return logout(svc)
        if op == "list":
            return _list(svc, q.get("id") or "")
        if op == "search":
            return {"ok": True, "items": PROVIDERS[svc].search(Session(svc), q.get("q", ""), q.get("id") or "")}
        if op == "open":
            return {"ok": True, "job": jobs.start(open_item, svc, q["id"])}
        if op == "pending":
            return pending()
        if op == "aperti":
            return opened()
        if op == "upload":
            return {"ok": True, "job": jobs.start(upload, os.path.abspath(q["path"]), q.get("force") == "1")}
        if op == "upload_copy":
            return {"ok": True, "job": jobs.start(upload_copy, os.path.abspath(q["path"]))}
        if op == "skip":
            return skip(os.path.abspath(q["path"]))
        if op == "check":
            return check(os.path.abspath(q["path"]))
        if op == "info":
            e = _entry(q["path"])
            return {"ok": True, "servizio": e["svc"], "nome": e["nome"], "web": e.get("web")}
        if op == "refresh":
            return {"ok": True, "job": jobs.start(refresh, os.path.abspath(q["path"]))}
        if op == "save_new":
            return {"ok": True, "job": jobs.start(save_new, body["src"], svc, body["folder"], body["name"], bool(body.get("replace")))}
    except CloudError as e:
        return {"ok": False, "errore": str(e), "login": e.login}
    raise CloudError(t("srv_cloud.operazione_sconosciuta"))
