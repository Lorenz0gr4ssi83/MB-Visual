"""Aggiunta di un account come in Outlook: si scrive solo l'indirizzo, MB Visual capisce da solo come collegarlo.

- `detect(email)`: PEC preimpostata -> password PEC; Gmail o dominio con posta Google (Workspace) -> accesso Google;
  Outlook.com/Hotmail o dominio con posta Microsoft 365 -> accesso Microsoft; tutto il resto -> configurazione automatica
  e password. Senza l'ID applicazione Google/Microsoft si ripiega sulla password (IMAP) con l'avviso adatto.
- `quick_add(email, password, cfg)`: prova IMAP e SMTP (anche con il nome utente senza dominio), salva da solo e
  restituisce errori in parole semplici con cosa fare (`codice`, `messaggio`, `aiuto`, `link`).
"""
import re

from ..i18n import t
from . import accounts, engine
from .imapc import MailError

GOOGLE_PERSONAL = ("gmail.com", "googlemail.com")
MS_PERSONAL = ("outlook.com", "outlook.it", "hotmail.com", "hotmail.it", "live.com", "live.it", "msn.com")
APP_PASSWORDS = "https://myaccount.google.com/apppasswords"
M365_IMAP = {"tipo": "imap", "imap": "outlook.office365.com", "imap_port": 993, "imap_sec": "ssl",
             "smtp": "smtp.office365.com", "smtp_port": 587, "smtp_sec": "starttls"}


def _oauth_ready():
    from . import oauth
    return oauth.status()["configurati"]


def detect(email: str, update=None) -> dict:
    email = email.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ValueError(t("srv_mail.indirizzo_non_valido"))
    dom = email.split("@")[1]
    cfg = accounts.autoconfig(email, update)
    imap = (cfg.get("imap") or "").lower()
    if cfg.get("pec"):
        via = "pec"
    elif dom in GOOGLE_PERSONAL or cfg.get("oauth") == "google" or imap.endswith("gmail.com") or imap.endswith("googlemail.com"):
        via = "google"
    elif dom in MS_PERSONAL or cfg.get("tipo") == "graph" or "office365.com" in imap or imap.endswith("outlook.com"):
        via = "microsoft"
    elif cfg.get("fonte") == "nessuna" or not cfg.get("imap"):
        via = "manuale"
    else:
        via = "password"
    ready = _oauth_ready()
    nota, gestore = cfg.get("nota", ""), cfg.get("gestore", "")
    if via == "google":
        gestore = "Gmail" if dom in GOOGLE_PERSONAL else "Google Workspace"
        if not ready.get("google"):
            p = accounts.PRESETS["gmail"]
            cfg = {k: p[k] for k in ("imap", "imap_port", "imap_sec", "smtp", "smtp_port", "smtp_sec")}
            cfg.update(tipo="imap", salva_inviati=False)
            via, nota = "password", t("mail.w_google_senza_id")
    elif via == "microsoft":
        gestore = "Outlook.com" if dom in MS_PERSONAL else "Microsoft 365"
        if not ready.get("microsoft"):
            cfg = dict(M365_IMAP)
            via, nota = "password", t("mail.w_microsoft_senza_id")
    cfg.pop("oauth", None) if via in ("pec", "password") else None
    return {"via": via, "email": email, "gestore": gestore or (t("mail.w_casella_aziendale") if via == "password" else ""),
            "cfg": {k: v for k, v in cfg.items() if k not in ("fonte", "nota", "preset", "mx")}, "nota": nota, "fonte": cfg.get("fonte", "")}


def display_name(email: str) -> str:
    """Nome visualizzato dalla parte prima della @ (mario.rossi -> Mario Rossi); si cambia poi nelle impostazioni."""
    local = email.split("@")[0]
    parts = [p for p in re.split(r"[._\-+]+", local) if p and not p.isdigit()]
    return " ".join(p.capitalize() for p in parts) or local


def _friendly(err: MailError, email: str, cfg: dict, stage: str) -> dict:
    dom = email.split("@")[1]
    google = dom in GOOGLE_PERSONAL or (cfg.get("imap") or "").endswith("gmail.com")
    if err.auth:
        if google:
            return {"codice": "password_google", "messaggio": t("mail.w_err_google_password"),
                    "aiuto": [t("mail.w_google_passo1"), t("mail.w_google_passo2"), t("mail.w_google_passo3")], "link": APP_PASSWORDS}
        if "office365" in (cfg.get("imap") or ""):
            return {"codice": "password_microsoft", "messaggio": t("mail.w_err_microsoft_password"), "aiuto": [t("mail.w_microsoft_aiuto")]}
        if cfg.get("pec"):
            return {"codice": "password", "messaggio": t("mail.w_err_password_pec"), "aiuto": [t("mail.w_pec_aiuto")]}
        return {"codice": "password", "messaggio": t("mail.w_err_password"), "aiuto": [t("mail.w_password_aiuto")]}
    if err.offline:
        return {"codice": "rete", "messaggio": t("mail.w_err_rete"), "aiuto": [t("mail.w_rete_aiuto")]}
    return {"codice": "server", "messaggio": t("mail.w_err_server_" + stage), "aiuto": [t("mail.w_server_aiuto")], "dettaglio": str(err)}


def quick_add(b: dict, update) -> dict:
    """Prova e salva un account con la sola password (IMAP+SMTP), come il pulsante "Accedi" di Outlook."""
    import smtplib
    from .imapc import Imap
    email = b["email"].strip().lower()
    pw = b.get("password") or ""
    cfg = dict(b.get("cfg") or {})
    cfg.setdefault("tipo", "imap")
    if not cfg.get("imap"):
        return {"ok": False, "codice": "impostazioni", "messaggio": t("mail.w_err_impostazioni"), "aiuto": [t("mail.w_impostazioni_aiuto")]}
    users = [cfg.get("utente") or email]
    if email.split("@")[0] not in users:
        users.append(email.split("@")[0])  # alcuni server vogliono il nome utente senza dominio
    last = None
    update(0.2, t("srv_mail.prova_imap"))
    user_ok = None
    for u in users:
        try:
            with Imap({**cfg, "utente": u, "_password": pw}, None, timeout=25):
                user_ok = u
                break
        except MailError as e:
            last = e
            if not e.auth:
                break
    if not user_ok:
        return {"ok": False, **_friendly(last, email, cfg, "imap")}
    update(0.6, t("srv_mail.prova_smtp"))
    acc_try = {**cfg, "utente": user_ok, "_password": pw, "email": email}
    try:
        smtp_user = _smtp_check(acc_try)
    except MailError as e:
        return {"ok": False, **_friendly(e, email, cfg, "smtp")}
    except smtplib.SMTPException as e:
        return {"ok": False, **_friendly(MailError(str(e)), email, cfg, "smtp")}
    update(0.9, t("mail.w_salvataggio"))
    acc = accounts.save_account({**cfg, "email": email, "utente": user_ok, "nome": b.get("nome") or display_name(email),
                                 "password": pw, "pec": bool(cfg.get("pec")), "gestore": b.get("gestore", ""),
                                 **({"utente_smtp": smtp_user} if smtp_user and smtp_user != user_ok else {})})
    engine.kick(acc["id"], "sync")
    return {"ok": True, "id": acc["id"], "nome": acc["nome"], "email": email}


def _smtp_check(acc):
    import smtplib
    host, port, sec = acc.get("smtp"), int(acc.get("smtp_port") or 465), acc.get("smtp_sec", "ssl")
    if not host:
        raise MailError(t("srv_mail.server_smtp_mancante"))
    try:
        s = smtplib.SMTP_SSL(host, port, timeout=20, context=accounts.tls_context(acc.get("_insicuro"))) if sec == "ssl" else smtplib.SMTP(host, port, timeout=20)
    except (OSError, smtplib.SMTPException) as e:
        raise MailError(t("srv_mail.server_non_raggiungibile", f"{host}:{port}", e), offline=True) from e
    try:
        s.ehlo()
        if sec == "starttls":
            s.starttls(context=accounts.tls_context(acc.get("_insicuro")))
            s.ehlo()
        if not s.has_extn("auth"):
            return acc["utente"]
        try:
            s.login(acc["utente"], acc["_password"])
            return acc["utente"]
        except smtplib.SMTPAuthenticationError as e:
            if acc["email"] == acc["utente"]:
                raise MailError(str(e), auth=True) from e
            try:  # stessa password ma utente con il dominio (alcuni server SMTP lo vogliono intero)
                s.login(acc["email"], acc["_password"])
                return acc["email"]
            except smtplib.SMTPAuthenticationError:
                raise MailError(str(e), auth=True) from e
    finally:
        try:
            s.quit()
        except Exception:  # noqa: BLE001
            pass
