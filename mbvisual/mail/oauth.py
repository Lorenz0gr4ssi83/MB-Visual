"""Accesso OAuth 2.0 + PKCE degli account di posta Microsoft 365 / Outlook.com (Microsoft Graph) e Gmail / Google
Workspace (IMAP e SMTP con XOAUTH2, CalDAV/CardDAV di Google con lo stesso token).

Stessa infrastruttura degli archivi cloud (mbvisual/cloud.py): ID applicazione da cloud.config() (servizi "onedrive" e
"gdrive", vedi ui/guide/posta.md), ritorno su http://localhost:<porta>/callback (Google: http://127.0.0.1:<porta>/),
browser predefinito. I token di ogni account stanno nei segreti cifrati della posta (accounts.secret(aid)["oauth"]).
"""
import secrets
import threading
import time
import webbrowser
from urllib.parse import urlencode

from .. import cloud, jobs
from ..i18n import t
from . import accounts

PROV = {
    "microsoft": {"svc": "onedrive", "nome": "Microsoft",
                  "auth": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
                  "token": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
                  "scope": "offline_access openid email profile User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite",
                  "me": "https://graph.microsoft.com/v1.0/me"},
    "google": {"svc": "gdrive", "nome": "Google",
               "auth": "https://accounts.google.com/o/oauth2/v2/auth",
               "token": "https://oauth2.googleapis.com/token",
               "scope": "https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/contacts openid email profile",
               "me": "https://openidconnect.googleapis.com/v1/userinfo"},
}
_LOCK = threading.RLock()


class OAuthError(Exception):
    pass


def _client(provider):
    cfg = cloud.config()
    c = cfg.get(PROV[provider]["svc"]) or {}
    if not c.get("client_id") or (provider == "google" and not c.get("client_secret")):
        raise ValueError(t("srv_mail.oauth_non_configurato", PROV[provider]["nome"]))
    return c, cfg["_port"]


def _url(provider, key, c):
    return PROV[provider][key].replace("{tenant}", c.get("tenant") or "common")


def _redirect(provider, port):
    return f"http://127.0.0.1:{port}/" if provider == "google" else f"http://localhost:{port}/callback"


def status() -> dict:
    out = {}
    cfg = cloud.config()
    for k, p in PROV.items():
        c = cfg.get(p["svc"]) or {}
        out[k] = bool(c.get("client_id")) and (k != "google" or bool(c.get("client_secret")))
    return {"ok": True, "configurati": out, "porta": cfg["_port"]}


def login_start(b: dict, open_browser=True) -> dict:
    provider = b.get("provider")
    if provider not in PROV:
        raise ValueError(t("srv_mail.operazione_sconosciuta"))
    c, port = _client(provider)
    cloud._start_listener(port)
    verifier, challenge = cloud._pkce()
    state = secrets.token_urlsafe(24)
    redirect = _redirect(provider, port)
    params = {"client_id": c["client_id"], "response_type": "code", "redirect_uri": redirect, "state": state,
              "code_challenge": challenge, "code_challenge_method": "S256", "scope": PROV[provider]["scope"]}
    if b.get("email"):
        params["login_hint"] = b["email"]
    if provider == "google":
        # select_account: senza, Google entra con l'account gia' aperto nel browser e un secondo Gmail non si aggiunge mai
        params.update(access_type="offline", prompt="select_account consent")
    else:
        params["prompt"] = "select_account"
    url = _url(provider, "auth", c) + "?" + urlencode(params)
    login = {"svc": "mail-" + provider, "verifier": verifier, "redirect": redirect, "event": threading.Event(), "cancel": False, "url": url}
    cloud._PENDING[state] = login
    job = jobs.start(_wait, state, provider, b)
    if open_browser:
        webbrowser.open(url)
    return {"ok": True, "job": job, "url": url}


def _wait(state, provider, b, update):
    login = cloud._PENDING[state]
    try:
        update(0.1, t("srv_cloud.attesa_dell_accesso_browser"))
        if not login["event"].wait(cloud.LOGIN_TIMEOUT):
            raise OAuthError(t("srv_cloud.tempo_scaduto_l_accesso_browser"))
        if login["cancel"]:
            raise OAuthError(t("srv_cloud.accesso_annullato"))
        if login.get("error"):
            raise OAuthError(t("srv_cloud.accesso_negato") if login.get("denied") else t("srv_cloud.accesso_non_riuscito_0", login["error"]))
        update(0.6, t("srv_cloud.verifica_dell_accesso"))
        c, _ = _client(provider)
        form = {"grant_type": "authorization_code", "code": login["code"], "redirect_uri": login["redirect"], "client_id": c["client_id"],
                "code_verifier": login["verifier"]}
        if provider == "google":
            form["client_secret"] = c["client_secret"]
        else:
            form["scope"] = PROV[provider]["scope"]
        tok = _token_request(provider, c, form)
        me = _profile(provider, tok["access_token"])
        email = (me.get("email") or b.get("email") or "").lower()
        asked = (b.get("email") or "").strip().lower()
        if asked and email and email != asked:  # entrato con un altro account: non si tocca l'account che c'e' gia'
            raise OAuthError(t("srv_mail.oauth_altro_account", asked, email))
        if not email:
            raise OAuthError(t("srv_mail.oauth_senza_email"))
        acc = _make_account(provider, email, b.get("nome") or me.get("nome") or email, b.get("id"))
        accounts.set_secret(acc["id"], oauth={**tok, "provider": provider, "account": {"email": email, "nome": me.get("nome", "")}})
        from . import engine
        engine.kick(acc["id"], "sync")
        return {"email": email, "id": acc["id"]}
    finally:
        cloud._PENDING.pop(state, None)
        cloud._stop_listener()


def _token_request(provider, c, form) -> dict:
    st, _, body = cloud._http("POST", _url(provider, "token", c), {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
                              urlencode(form).encode())
    j = cloud._jsonb(body)
    if st != 200 or not j.get("access_token"):
        raise OAuthError(t("srv_cloud.accesso_rifiutato", PROV[provider]["nome"], cloud._err_text(body) or st))
    return {"access_token": j["access_token"], "refresh_token": j.get("refresh_token") or form.get("refresh_token"),
            "expires_at": time.time() + int(j.get("expires_in") or 3600)}


def _profile(provider, token) -> dict:
    st, _, body = cloud._http("GET", PROV[provider]["me"], {"Authorization": "Bearer " + token, "Accept": "application/json"})
    j = cloud._jsonb(body) if st == 200 else {}
    if provider == "microsoft":
        return {"email": j.get("mail") or j.get("userPrincipalName") or "", "nome": j.get("displayName") or ""}
    return {"email": j.get("email") or "", "nome": j.get("name") or ""}


def _make_account(provider, email, nome, aid=None) -> dict:
    existing = next((a for a in accounts.all_accounts() if a["id"] == aid or (a.get("email") == email and a.get("oauth") == provider)), None)
    if provider == "microsoft":
        body = {"tipo": "graph", "oauth": "microsoft", "email": email, "nome": nome, "salva_inviati": False}
    else:
        p = accounts.PRESETS["gmail"]
        body = {"tipo": "imap", "oauth": "google", "email": email, "nome": nome, "utente": email, "imap": p["imap"], "imap_port": p["imap_port"],
                "imap_sec": p["imap_sec"], "smtp": p["smtp"], "smtp_port": p["smtp_port"], "smtp_sec": p["smtp_sec"], "salva_inviati": False,
                "caldav": "https://apidata.googleusercontent.com/caldav/v2/", "carddav": "https://www.googleapis.com/carddav/v1/principals/"}
    if existing:
        body["id"] = existing["id"]
    return accounts.save_account(body)


def access_token(acc: dict) -> str:
    """Token valido per l'account (rinnovato con il refresh token quando sta per scadere)."""
    with _LOCK:
        sec = accounts.secret(acc["id"])
        tok = sec.get("oauth")
        if not tok:
            from .imapc import MailError
            raise MailError(t("srv_mail.oauth_accedi_di_nuovo", acc.get("email", "")), auth=True)
        if tok.get("expires_at", 0) - 120 > time.time():
            return tok["access_token"]
        provider = tok.get("provider") or acc.get("oauth")
        c, _ = _client(provider)
        form = {"grant_type": "refresh_token", "refresh_token": tok.get("refresh_token") or "", "client_id": c["client_id"]}
        if provider == "google":
            form["client_secret"] = c["client_secret"]
        else:
            form["scope"] = PROV[provider]["scope"]
        try:
            new = _token_request(provider, c, form)
        except OAuthError as e:
            from .imapc import MailError
            raise MailError(t("srv_mail.oauth_accedi_di_nuovo", acc.get("email", "")) + f" ({e})", auth=True) from e
        except cloud.CloudError as e:
            from .imapc import MailError
            raise MailError(str(e), offline=True) from e
        tok.update(new)
        accounts.set_secret(acc["id"], oauth=tok)
        return tok["access_token"]
