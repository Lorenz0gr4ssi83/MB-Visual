"""Sfondi cartografici per il visualizzatore GIS (ui/js/viewers/gis.js).

Le tessere passano dal server locale per tre motivi:
- la pagina dell'app e' isolata (COOP/COEP): immagini di altri siti senza intestazioni CORS non si possono disegnare;
- la policy di tile.openstreetmap.org chiede un User-Agent che identifichi l'app e una cache di almeno 7 giorni
  che rispetti le intestazioni del server (https://operations.osmfoundation.org/policies/tiles/);
- l'esportazione PNG/PDF della vista legge i pixel della mappa (servono immagini della stessa origine).
Si scaricano SOLO le tessere che l'utente sta guardando: niente pre-scaricamento di aree (vietato da OSM).
"""
import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime

from .paths import TEMP_DIR

CACHE = TEMP_DIR / "gis-tessere"
MIN_AGE = 7 * 24 * 3600          # minimo chiesto da OSM se il server non dice altro
MAX_CACHE = 400 * 1024 * 1024     # oltre si tolgono le tessere meno recenti
_lock = threading.Lock()
_ua = None

# fornitori predefiniti: l'URL resta qui (l'interfaccia manda solo il nome); {key} = chiave dell'utente
PROVIDERS = {
    "osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "esri": "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={key}",
    "maptiler": "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}",
}


def _user_agent() -> str:
    global _ua
    if _ua is None:
        try:
            from . import update
            ver = update.current().get("versione", "?")
        except Exception:  # noqa: BLE001
            ver = "?"
        _ua = f"MBVisual/{ver} (visualizzatore GIS; +https://github.com/Lorenz0gr4ssi83/MB-Visual-Rilasci)"
    return _ua


def _check_url(url: str) -> str:
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.netloc:
        raise ValueError("Indirizzo del servizio di mappe non valido (serve http:// o https://)")
    return url


def build_url(qs: dict) -> str:
    """Ricostruisce l'indirizzo della tessera dai parametri della richiesta (dict di liste, come parse_qs)."""
    one = {k: v[0] for k, v in qs.items() if v}
    p = one.get("p", "")
    if p == "wms":
        base = _check_url(one.get("base", ""))
        extra = {k: v for k, v in one.items() if k not in ("p", "base", "t", "key")}
        return base + ("&" if "?" in base else "?") + urllib.parse.urlencode(extra)
    if p == "url":   # icone dei KML (es. segnaposto di Google Earth)
        return _check_url(one.get("u", ""))
    tpl = PROVIDERS.get(p) or (one.get("tpl", "") if p == "xyz" else "")
    if not tpl:
        raise ValueError("Sfondo sconosciuto")
    z, x, y = int(one["z"]), int(one["x"]), int(one["y"])
    sub = "abc"[(x + y) % 3]
    url = (tpl.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
           .replace("{-y}", str((1 << z) - 1 - y)).replace("{s}", sub)
           .replace("{key}", urllib.parse.quote(one.get("key", ""), safe="")))
    return _check_url(url)


def _max_age(headers) -> int:
    cc = headers.get("Cache-Control", "") or ""
    m = re.search(r"max-age=(\d+)", cc)
    age = int(m.group(1)) if m else 0
    if not m and headers.get("Expires"):
        try:
            age = int(parsedate_to_datetime(headers["Expires"]).timestamp() - time.time())
        except (TypeError, ValueError):
            age = 0
    return max(age, MIN_AGE)


def _trim_cache():
    files = sorted((f for f in CACHE.glob("*.bin")), key=lambda f: f.stat().st_mtime)
    total = sum(f.stat().st_size for f in files)
    for f in files:
        if total <= MAX_CACHE * 0.8:
            break
        total -= f.stat().st_size
        f.unlink(missing_ok=True)
        f.with_suffix(".json").unlink(missing_ok=True)


def fetch(qs: dict) -> tuple[int, bytes, str]:
    """Ritorna (codice HTTP, contenuto, tipo). Usa la cache su disco e le richieste condizionali."""
    url = build_url(qs)
    CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()
    data_f, meta_f = CACHE / (key + ".bin"), CACHE / (key + ".json")
    meta = None
    if data_f.exists() and meta_f.exists():
        try:
            meta = json.loads(meta_f.read_text(encoding="utf-8"))
        except ValueError:
            meta = None
        if meta and meta.get("scade", 0) > time.time():
            return 200, data_f.read_bytes(), meta.get("tipo", "image/png")
    req = urllib.request.Request(url, headers={"User-Agent": _user_agent(), "Accept": "image/*,*/*;q=0.8"})
    if meta:
        if meta.get("etag"):
            req.add_header("If-None-Match", meta["etag"])
        if meta.get("modificato"):
            req.add_header("If-Modified-Since", meta["modificato"])
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read()
            headers = r.headers
            code = r.status
    except urllib.error.HTTPError as e:
        if e.code == 304 and meta:
            meta["scade"] = time.time() + _max_age(e.headers)
            meta_f.write_text(json.dumps(meta), encoding="utf-8")
            return 200, data_f.read_bytes(), meta.get("tipo", "image/png")
        return e.code, e.read()[:2000], e.headers.get("Content-Type", "text/plain")
    tipo = headers.get("Content-Type", "image/png").split(";")[0]
    if code == 200 and tipo.startswith("image/"):
        with _lock:
            data_f.write_bytes(body)
            meta_f.write_text(json.dumps({"url": url, "tipo": tipo, "scade": time.time() + _max_age(headers),
                                          "etag": headers.get("ETag"), "modificato": headers.get("Last-Modified")}),
                              encoding="utf-8")
            if hash(key) % 200 == 0:
                _trim_cache()
    return code, body, tipo
