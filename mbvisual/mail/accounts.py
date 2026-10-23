"""Account di posta: impostazioni (posta/account.json, senza segreti), password e token cifrati (posta/segreti.bin,
AES-GCM con la chiave DPAPI), gestori preimpostati (PEC e caselle comuni) e configurazione automatica.

Configurazione automatica, in ordine: gestori preimpostati per dominio -> autoconfig del dominio
(autoconfig.<dominio>/mail/config-v1.1.xml e /.well-known) -> banca dati ISPDB di Thunderbird -> Autodiscover di
Microsoft (POX) -> record MX (dominio del server di posta: Google, Microsoft, Aruba...) -> nomi tipici (imap./mail.).
"""
import json
import os
import re
import secrets
import socket
import ssl
import subprocess
import threading
import xml.etree.ElementTree as ET
from urllib.parse import quote
from urllib.request import Request, urlopen

from . import vault
from ..paths import NO_WINDOW
from ..i18n import t

ACC_FILE = vault.DATA_DIR / "account.json"
SEC_FILE = vault.DATA_DIR / "segreti.bin"
_LOCK = threading.RLock()

# ------------------------------------------------------------------ gestori preimpostati
# PEC: parametri pubblicati dai gestori (porte SSL/TLS 993 e 465). nota = chiave di testo con un avviso.
PEC = [
    {"id": "aruba", "nome": "Aruba PEC", "domini": ["pec.it", "arubapec.it", "gigapec.it", "mypec.eu", "pec.aruba.it", "postacertificata.email"],
     "imap": "imaps.pec.aruba.it", "smtp": "smtps.pec.aruba.it", "nota": "mail.nota_aruba"},
    {"id": "legalmail", "nome": "Legalmail (InfoCert)", "domini": ["legalmail.it"],
     "imap": "mbox.cert.legalmail.it", "smtp": "sendm.cert.legalmail.it", "nota": "mail.nota_legalmail"},
    {"id": "namirial", "nome": "Namirial", "domini": ["sicurezzapostale.it", "pecavvocati.it", "pec.commercialisti.it", "mypcert.it"],
     "imap": "imaps.sicurezzapostale.it", "smtp": "smtps.sicurezzapostale.it", "nota": "mail.nota_namirial"},
    {"id": "postecert", "nome": "Poste Italiane (Postecert)", "domini": ["postecert.it"],
     "imap": "mail.postecert.it", "smtp": "mail.postecert.it"},
    {"id": "postecertifica", "nome": "Poste Italiane (Postecertifica)", "domini": ["postecertifica.it"],
     "imap": "mail.postecertifica.it", "smtp": "mail.postecertifica.it", "nota": "mail.nota_password_app"},
    {"id": "register", "nome": "Register PEC", "domini": ["registerpec.it", "pec-mail.it", "dadapec.com"],
     "imap": "imap.pec-email.com", "smtp": "smtp.pec-email.com"},
    {"id": "actalis", "nome": "Actalis", "domini": ["pec.actalis.it", "actaliscertymail.it"],
     "imap": "imap.pec.actalis.it", "smtp": "smtp.pec.actalis.it"},
    {"id": "libero", "nome": "Libero PEC", "domini": ["pec.libero.it"],
     "imap": "mail.postacert.it.net", "smtp": "mail.postacert.it.net"},
    {"id": "tim", "nome": "TIM PEC", "domini": ["timpec.it", "pec.telecomitalia.it"],
     "imap": "imap.pectim.it", "smtp": "smtp.pectim.it", "nota": "mail.nota_tim"},
]
for _p in PEC:
    _p.update(imap_port=993, imap_sec="ssl", smtp_port=465, smtp_sec="ssl", pec=True)

COMMON = [
    {"id": "gmail", "nome": "Gmail", "domini": ["gmail.com", "googlemail.com"], "imap": "imap.gmail.com", "imap_port": 993, "imap_sec": "ssl",
     "smtp": "smtp.gmail.com", "smtp_port": 465, "smtp_sec": "ssl", "oauth": "google", "salva_inviati": False, "nota": "mail.nota_gmail"},
    {"id": "outlook", "nome": "Outlook.com / Hotmail", "domini": ["outlook.com", "hotmail.com", "hotmail.it", "live.com", "live.it", "msn.com"],
     "tipo": "graph", "oauth": "microsoft"},
    {"id": "libero_mail", "nome": "Libero Mail", "domini": ["libero.it", "inwind.it", "blu.it", "iol.it", "giallo.it"],
     "imap": "imapmail.libero.it", "imap_port": 993, "imap_sec": "ssl", "smtp": "smtp.libero.it", "smtp_port": 465, "smtp_sec": "ssl"},
    {"id": "virgilio", "nome": "Virgilio", "domini": ["virgilio.it"],
     "imap": "in.virgilio.it", "imap_port": 993, "imap_sec": "ssl", "smtp": "out.virgilio.it", "smtp_port": 465, "smtp_sec": "ssl"},
    {"id": "tim_mail", "nome": "TIM Mail", "domini": ["tim.it", "alice.it", "tin.it"],
     "imap": "imap.tim.it", "imap_port": 993, "imap_sec": "ssl", "smtp": "smtp.tim.it", "smtp_port": 465, "smtp_sec": "ssl"},
    {"id": "tiscali", "nome": "Tiscali", "domini": ["tiscali.it"],
     "imap": "imap.tiscali.it", "imap_port": 993, "imap_sec": "ssl", "smtp": "smtp.tiscali.it", "smtp_port": 465, "smtp_sec": "ssl"},
    {"id": "aruba_mail", "nome": "Aruba (posta ordinaria)", "domini": [],
     "imap": "imaps.aruba.it", "imap_port": 993, "imap_sec": "ssl", "smtp": "smtps.aruba.it", "smtp_port": 465, "smtp_sec": "ssl"},
    {"id": "yahoo", "nome": "Yahoo Mail", "domini": ["yahoo.com", "yahoo.it", "ymail.com"],
     "imap": "imap.mail.yahoo.com", "imap_port": 993, "imap_sec": "ssl", "smtp": "smtp.mail.yahoo.com", "smtp_port": 465, "smtp_sec": "ssl",
     "nota": "mail.nota_password_app"},
    {"id": "icloud", "nome": "iCloud Mail", "domini": ["icloud.com", "me.com", "mac.com"],
     "imap": "imap.mail.me.com", "imap_port": 993, "imap_sec": "ssl", "smtp": "smtp.mail.me.com", "smtp_port": 587, "smtp_sec": "starttls",
     "nota": "mail.nota_password_app"},
    {"id": "m365", "nome": "Microsoft 365 (Exchange Online)", "domini": [], "tipo": "graph", "oauth": "microsoft"},
]
PRESETS = {p["id"]: p for p in PEC + COMMON}
# server dei record MX -> gestore (domini propri ospitati da Google, Microsoft, Aruba...)
MX_HINTS = [("google.com", "gmail"), ("googlemail.com", "gmail"), ("outlook.com", "m365"), ("aruba.it", "aruba_mail"),
            ("libero.it", "libero_mail"), ("register.it", None)]


def presets() -> dict:
    return {"pec": PEC, "comuni": COMMON}


# ------------------------------------------------------------------ archivio degli account
def _load() -> dict:
    try:
        return json.loads(ACC_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return {"account": []}


def _save(d: dict):
    vault.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ACC_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1, ensure_ascii=False), "utf-8")
    os.replace(tmp, ACC_FILE)


def _secrets() -> dict:
    try:
        return json.loads(vault.read(SEC_FILE, b"segreti"))
    except FileNotFoundError:
        return {}


def _save_secrets(d: dict):
    vault.write(SEC_FILE, json.dumps(d).encode("utf-8"), b"segreti")


def secret(aid: str) -> dict:
    with _LOCK:
        return dict(_secrets().get(aid) or {})


def set_secret(aid: str, **vals):
    with _LOCK:
        s = _secrets()
        cur = s.setdefault(aid, {})
        for k, v in vals.items():
            if v is None:
                cur.pop(k, None)
            else:
                cur[k] = v
        _save_secrets(s)


def all_accounts() -> list:
    with _LOCK:
        return _load()["account"]


def get(aid: str) -> dict:
    for a in all_accounts():
        if a["id"] == aid:
            return a
    raise KeyError(t("srv_mail.account_inesistente"))


FIELDS = ("nome", "email", "tipo", "imap", "imap_port", "imap_sec", "smtp", "smtp_port", "smtp_sec", "utente", "utente_smtp",
          "pec", "oauth", "salva_inviati", "colore", "firma", "firma_nuovi", "firma_risposte", "scarica_giorni", "intervallo",
          "gestore", "alias", "caldav", "carddav", "dav_utente", "attivo", "ordine", "notifiche", "cartelle_extra")


def save_account(body: dict) -> dict:
    with _LOCK:
        d = _load()
        aid = body.get("id") or ("a" + secrets.token_hex(5))
        acc = next((a for a in d["account"] if a["id"] == aid), None)
        if acc is None:
            acc = {"id": aid, "tipo": "imap", "attivo": True, "salva_inviati": True, "scarica_giorni": 365, "intervallo": 3}
            d["account"].append(acc)
        for k in FIELDS:
            if k in body:
                acc[k] = body[k]
        if not acc.get("nome"):
            from .wizard import display_name
            acc["nome"] = display_name(acc.get("email", "")) if acc.get("email") else ""
        _save(d)
    if body.get("password") is not None:
        set_secret(aid, password=body["password"] or None)
    if body.get("password_smtp") is not None:
        set_secret(aid, password_smtp=body["password_smtp"] or None)
    if body.get("dav_password") is not None:
        set_secret(aid, dav_password=body["dav_password"] or None)
    return acc


def delete_account(aid: str):
    with _LOCK:
        d = _load()
        d["account"] = [a for a in d["account"] if a["id"] != aid]
        _save(d)
        s = _secrets()
        s.pop(aid, None)
        _save_secrets(s)


def reorder(ids: list):
    with _LOCK:
        d = _load()
        pos = {x: i for i, x in enumerate(ids)}
        d["account"].sort(key=lambda a: pos.get(a["id"], 999))
        _save(d)


def public(a: dict) -> dict:
    s = secret(a["id"])
    return {**a, "ha_password": bool(s.get("password")), "ha_token": bool(s.get("oauth")),
            "oauth_account": (s.get("oauth") or {}).get("account")}


# ------------------------------------------------------------------ configurazione automatica
def _fetch(url, timeout=6) -> bytes | None:
    try:
        with urlopen(Request(url, headers={"User-Agent": "MBVisual"}), timeout=timeout) as r:  # noqa: S310
            if r.status == 200:
                return r.read(200000)
    except Exception:  # noqa: BLE001
        return None
    return None


def _parse_autoconfig(xmlb: bytes, emailaddr: str) -> dict | None:
    try:
        root = ET.fromstring(xmlb)
    except ET.ParseError:
        return None
    local, _, dom = emailaddr.partition("@")

    def sub(v):
        return (v or "").replace("%EMAILADDRESS%", emailaddr).replace("%EMAILLOCALPART%", local).replace("%EMAILDOMAIN%", dom)
    out = {}
    for s in root.iter("incomingServer"):
        if s.get("type") == "imap" and "imap" not in out:
            sock = (s.findtext("socketType") or "").upper()
            out.update(imap=sub(s.findtext("hostname")), imap_port=int(s.findtext("port") or 993),
                       imap_sec="ssl" if sock == "SSL" else "starttls" if sock == "STARTTLS" else "none",
                       utente=sub(s.findtext("username")))
            auths = [a.text for a in s.findall("authentication")]
            if "OAuth2" in auths:
                out["oauth_possibile"] = True
    for s in root.iter("outgoingServer"):
        if s.get("type") == "smtp" and "smtp" not in out:
            sock = (s.findtext("socketType") or "").upper()
            out.update(smtp=sub(s.findtext("hostname")), smtp_port=int(s.findtext("port") or 465),
                       smtp_sec="ssl" if sock == "SSL" else "starttls" if sock == "STARTTLS" else "none")
            u = sub(s.findtext("username"))
            if u and u != out.get("utente"):
                out["utente_smtp"] = u
    name = root.findtext(".//emailProvider/displayName")
    if name:
        out["gestore"] = name
    return out if out.get("imap") else None


def _autodiscover(emailaddr: str) -> dict | None:
    dom = emailaddr.split("@")[1]
    body = ('<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">'
            f"<Request><EMailAddress>{emailaddr}</EMailAddress><AcceptableResponseSchema>"
            "http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>").encode()
    for url in (f"https://autodiscover.{dom}/autodiscover/autodiscover.xml", f"https://{dom}/autodiscover/autodiscover.xml"):
        try:
            with urlopen(Request(url, data=body, headers={"Content-Type": "text/xml", "User-Agent": "MBVisual"}), timeout=6) as r:  # noqa: S310
                x = r.read(200000)
        except Exception:  # noqa: BLE001
            continue
        x = re.sub(rb'\sxmlns="[^"]+"', b"", x)
        try:
            root = ET.fromstring(x)
        except ET.ParseError:
            continue
        out = {}
        for p in root.iter("Protocol"):
            typ = (p.findtext("Type") or "").upper()
            host, port = p.findtext("Server"), int(p.findtext("Port") or 0)
            ssl_on = (p.findtext("SSL") or "on").lower() == "on"
            enc = (p.findtext("Encryption") or "").lower()
            sec = "ssl" if (ssl_on and port in (993, 465)) or enc == "ssl" else "starttls" if ssl_on or enc == "tls" else "none"
            if typ == "IMAP" and host:
                out.update(imap=host, imap_port=port or 993, imap_sec=sec)
            elif typ == "SMTP" and host:
                out.update(smtp=host, smtp_port=port or 587, smtp_sec=sec)
        if out.get("imap"):
            return out
    return None


def mx(domain: str) -> list:
    """Server MX del dominio (nslookup di Windows: nessuna libreria DNS in piu')."""
    try:
        r = subprocess.run(["nslookup", "-type=mx", domain], capture_output=True, text=True, timeout=8,
                           creationflags=NO_WINDOW)
    except Exception:  # noqa: BLE001
        return []
    return [m.lower().rstrip(".") for m in re.findall(r"mail exchanger = (\S+)", r.stdout)]


def _probe(host, port, timeout=4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def autoconfig(emailaddr: str, update=None) -> dict:
    emailaddr = emailaddr.strip().lower()
    if "@" not in emailaddr:
        raise ValueError(t("srv_mail.indirizzo_non_valido"))
    dom = emailaddr.split("@")[1]
    step = (lambda p, m: update(p, m)) if update else (lambda p, m: None)
    for p in PEC + COMMON:
        if dom in p["domini"]:
            return {"fonte": "preimpostato", **_preset_cfg(p, emailaddr)}
    step(0.15, t("srv_mail.autoconfig_dominio"))
    for url in (f"https://autoconfig.{dom}/mail/config-v1.1.xml?emailaddress={quote(emailaddr)}",
                f"https://{dom}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress={quote(emailaddr)}",
                f"http://autoconfig.{dom}/mail/config-v1.1.xml?emailaddress={quote(emailaddr)}"):
        x = _fetch(url)
        cfg = x and _parse_autoconfig(x, emailaddr)
        if cfg:
            return {"fonte": "autoconfig", "tipo": "imap", **cfg}
    step(0.35, t("srv_mail.autoconfig_ispdb"))
    x = _fetch(f"https://autoconfig.thunderbird.net/v1.1/{dom}")
    cfg = x and _parse_autoconfig(x, emailaddr)
    if cfg:
        return {"fonte": "ispdb", "tipo": "imap", **cfg}
    step(0.5, t("srv_mail.autoconfig_mx"))
    mxs = mx(dom)
    for m in mxs:
        for suffix, pid in MX_HINTS:
            if m.endswith(suffix) and pid:
                return {"fonte": "mx", "mx": m, **_preset_cfg(PRESETS[pid], emailaddr)}
        # dominio del server MX nella ISPDB (es. mx.ditta.it -> ospitato da un provider noto)
        base = ".".join(m.split(".")[-2:])
        if base != dom:
            x = _fetch(f"https://autoconfig.thunderbird.net/v1.1/{base}")
            cfg = x and _parse_autoconfig(x, emailaddr)
            if cfg:
                return {"fonte": "mx", "mx": m, "tipo": "imap", **cfg}
    step(0.65, t("srv_mail.autoconfig_autodiscover"))
    cfg = _autodiscover(emailaddr)
    if cfg:
        return {"fonte": "autodiscover", "tipo": "imap", "utente": emailaddr, **cfg}
    step(0.8, t("srv_mail.autoconfig_prova_nomi"))
    out = {"fonte": "ipotesi", "tipo": "imap", "utente": emailaddr}
    for h in (f"imap.{dom}", f"mail.{dom}", f"imaps.{dom}"):
        if _probe(h, 993):
            out.update(imap=h, imap_port=993, imap_sec="ssl")
            break
        if _probe(h, 143):
            out.update(imap=h, imap_port=143, imap_sec="starttls")
            break
    for h in (f"smtp.{dom}", f"mail.{dom}", f"smtps.{dom}"):
        for port, sec in ((465, "ssl"), (587, "starttls")):
            if _probe(h, port):
                out.update(smtp=h, smtp_port=port, smtp_sec=sec)
                break
        if out.get("smtp"):
            break
    if not out.get("imap"):
        out["fonte"] = "nessuna"
    return out


def _preset_cfg(p: dict, emailaddr: str) -> dict:
    c = {k: v for k, v in p.items() if k not in ("domini", "id", "nome", "nota")}
    c.setdefault("tipo", "imap")
    c["gestore"] = p["nome"]
    c["preset"] = p["id"]
    if p.get("nota"):
        c["nota"] = t(p["nota"])
    if c["tipo"] == "imap":
        c.setdefault("utente", emailaddr)
    return c


def tls_context(insecure=False):
    ctx = ssl.create_default_context()
    if insecure:  # solo server di prova locali (certificato autofirmato)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx
