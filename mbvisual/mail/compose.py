"""Composizione dei messaggi (MIME) e invio SMTP (password o XOAUTH2)."""
import base64
import mimetypes
import re
import smtplib
import time
import uuid
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

from . import accounts, parse
from .imapc import MailError
from ..i18n import t


def _fmt(lst) -> str:
    out = []
    for x in lst or []:
        if isinstance(x, str):
            out.append(x.strip())
        elif x.get("a"):
            out.append(formataddr((x.get("n") or "", x["a"])))
    return ", ".join(o for o in out if o)


def html_inline_images(h: str):
    """Immagini incollate (data:) -> parti cid: (piu' compatibili con i programmi di posta)."""
    imgs = []

    def rep(m):
        ctype, b64 = m.group(1), m.group(2)
        cid = f"img{len(imgs) + 1}.{uuid.uuid4().hex[:10]}@mbvisual"
        try:
            imgs.append((cid, ctype, base64.b64decode(b64)))
        except ValueError:
            return m.group(0)
        return f'src="cid:{cid}"'
    h = re.sub(r'src="data:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)"', rep, h or "")
    return h, imgs


def build(d: dict, acc: dict) -> tuple[bytes, dict]:
    """Messaggio da composizione {to, cc, bcc, subject, html, text, atts:[{path, nome}], in_reply_to, refs, priority,
    ricevuta, from_name, alias}. Restituisce (byte RFC 822, info) - Bcc compreso (si toglie solo nella trasmissione)."""
    m = EmailMessage()
    sender = d.get("alias") or acc.get("email")
    m["From"] = formataddr((d.get("from_name") if d.get("from_name") is not None else acc.get("nome_mittente") or acc.get("nome") or "", sender))
    for h, k in (("To", "to"), ("Cc", "cc"), ("Bcc", "bcc")):
        v = _fmt(d.get(k))
        if v:
            m[h] = v
    if d.get("reply_to"):
        m["Reply-To"] = _fmt(d["reply_to"])
    m["Subject"] = d.get("subject") or ""
    m["Date"] = formatdate(localtime=True)
    dom = (sender or "mbvisual.local").split("@")[-1]
    m["Message-ID"] = d.get("msgid") or make_msgid(domain=dom)
    if d.get("in_reply_to"):
        m["In-Reply-To"] = d["in_reply_to"]
    if d.get("refs") or d.get("in_reply_to"):
        refs = (d.get("refs") or "").split()
        if d.get("in_reply_to") and d["in_reply_to"] not in refs:
            refs.append(d["in_reply_to"])
        m["References"] = " ".join(refs[-20:])
    if d.get("priority") == 1:
        m["X-Priority"] = "1 (Highest)"
        m["Importance"] = "High"
    elif d.get("priority") == -1:
        m["X-Priority"] = "5 (Lowest)"
        m["Importance"] = "Low"
    if d.get("ricevuta"):
        m["Disposition-Notification-To"] = sender
    if d.get("draft"):
        m["X-MBV-Draft"] = "1"
    m["X-Mailer"] = "MB Desk"
    htm, imgs = html_inline_images(d.get("html") or "")
    text = d.get("text") or (parse.html_to_text(htm) if htm else "")
    m.set_content(text or "")
    for ics in d.get("ics") or []:  # inviti e risposte alle riunioni: text/calendar con METHOD come alternativa (come Outlook)
        m.add_alternative(ics["data"], subtype="calendar", params={"method": ics.get("method", "REQUEST")})
    if htm:
        m.add_alternative(htm, subtype="html")
        if imgs:
            alt = [p for p in m.get_payload() if p.get_content_type() == "text/html"][0]
            for cid, ctype, data in imgs:
                maintype, subtype = ctype.split("/", 1)
                alt.add_related(data, maintype=maintype, subtype=subtype, cid=f"<{cid}>")
    for a in d.get("atts") or []:
        if a.get("raw") is not None:
            data = a["raw"]
        else:
            p = Path(a["path"])
            if not p.is_file():
                raise MailError(t("srv_mail.allegato_non_trovato", p.name))
            data = p.read_bytes()
        name = a.get("nome") or Path(a.get("path", "allegato")).name
        ctype = a.get("tipo") or mimetypes.guess_type(name)[0] or "application/octet-stream"
        if ctype == "message/rfc822":
            m.add_attachment(parse.msg_from_bytes(data), filename=name)
        else:
            maintype, subtype = ctype.split("/", 1)
            m.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)

    raw = m.as_bytes()
    rcpt = [x["a"] if isinstance(x, dict) else x for k in ("to", "cc", "bcc") for x in (d.get(k) or [])]
    rcpt = [parse.addrs(r)[0]["a"] if isinstance(r, str) and parse.addrs(r) else r for r in rcpt]
    return raw, {"msgid": m["Message-ID"], "rcpt": [r for r in rcpt if r], "from": sender}


def strip_bcc(raw: bytes) -> bytes:
    head, sep, body = raw.partition(b"\r\n\r\n")
    if not sep:
        head, sep, body = raw.partition(b"\n\n")
    lines, skip = [], False
    for ln in re.split(rb"(\r?\n)", head):
        if ln in (b"\r\n", b"\n"):
            if not skip:
                lines.append(ln)
            continue
        if ln[:1] in (b" ", b"\t") and skip:
            continue
        skip = ln.lower().startswith(b"bcc:")
        if not skip:
            lines.append(ln)
    out = b"".join(lines)
    out = re.sub(rb"(\r?\n)+$", b"", out)
    return out + sep + body


def send(acc: dict, raw: bytes, sender: str, rcpt: list, token_fn=None, timeout=120):
    host, port, sec = acc.get("smtp"), int(acc.get("smtp_port") or 465), acc.get("smtp_sec", "ssl")
    if not host:
        raise MailError(t("srv_mail.server_smtp_mancante"))
    if not rcpt:
        raise MailError(t("srv_mail.nessun_destinatario"))
    insecure = bool(acc.get("_insicuro"))
    try:
        if sec == "ssl":
            s = smtplib.SMTP_SSL(host, port, timeout=timeout, context=accounts.tls_context(insecure))
        else:
            s = smtplib.SMTP(host, port, timeout=timeout)
            s.ehlo()
            if sec == "starttls":
                s.starttls(context=accounts.tls_context(insecure))
                s.ehlo()
    except (OSError, smtplib.SMTPException) as e:
        raise MailError(t("srv_mail.server_non_raggiungibile", f"{host}:{port}", e), offline=True) from e
    try:
        user = acc.get("utente_smtp") or acc.get("utente") or acc.get("email")
        if token_fn:
            tok = token_fn()
            s.ehlo()
            code, resp = s.docmd("AUTH", "XOAUTH2 " + base64.b64encode(f"user={user}\x01auth=Bearer {tok}\x01\x01".encode()).decode())
            if code != 235:
                raise MailError(t("srv_mail.accesso_rifiutato", resp.decode("utf-8", "replace")), auth=True)
        elif sec != "none" or acc.get("_password") or accounts.secret(acc.get("id", "")).get("password"):
            sec_ = accounts.secret(acc["id"]) if acc.get("id") else {}
            pw = acc.get("_password") or sec_.get("password_smtp") or sec_.get("password")
            if pw and s.has_extn("auth"):
                try:
                    s.login(user, pw)
                except smtplib.SMTPAuthenticationError as e:
                    raise MailError(t("srv_mail.accesso_rifiutato", e.smtp_error.decode("utf-8", "replace")), auth=True) from e
        try:
            refused = s.sendmail(sender, rcpt, strip_bcc(raw))
        except smtplib.SMTPRecipientsRefused as e:
            raise MailError(t("srv_mail.destinatari_rifiutati", ", ".join(e.recipients))) from e
        except smtplib.SMTPSenderRefused as e:
            raise MailError(t("srv_mail.mittente_rifiutato", e.smtp_error.decode("utf-8", "replace"))) from e
        except smtplib.SMTPDataError as e:
            raise MailError(t("srv_mail.messaggio_rifiutato", e.smtp_error.decode("utf-8", "replace"))) from e
        return {"rifiutati": list(refused.keys()), "ora": time.time()}
    finally:
        try:
            s.quit()
        except Exception:  # noqa: BLE001
            pass
