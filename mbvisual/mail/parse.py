"""Lettura dei messaggi RFC 822: riepilogo per l'indice, contenuto per la lettura, allegati, PEC e inviti.

PEC (regole tecniche DM 2/11/2005): il gestore firma (S/MIME) una busta con il testo del gestore, daticert.xml e,
per i messaggi, l'originale postacert.eml. Le ricevute hanno X-Ricevuta e X-Riferimento-Message-ID = Message-ID del
messaggio inviato: cosi' si collegano al messaggio nella cartella Inviata.
"""
import email
import email.policy
import html
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.utils import getaddresses, parseaddr, parsedate_to_datetime

POLICY = email.policy.default.clone(raise_on_defect=False)
PEC_TYPES = ("posta-certificata", "accettazione", "non-accettazione", "presa-in-carico", "avvenuta-consegna",
             "errore-consegna", "preavviso-errore-consegna", "rilevazione-virus")
_RE_PREFIX = re.compile(r"^\s*((re|r|fw|fwd|i|inoltra|rif|aw|wg|tr|rv|sv|antw|posta certificata|anomalia messaggio)\s*(\[\d+\])?\s*:\s*)+", re.I)


def msg_from_bytes(raw: bytes):
    return email.message_from_bytes(raw, policy=POLICY)


def dec(v) -> str:
    if v is None:
        return ""
    try:
        return str(make_header(decode_header(str(v)))).strip()
    except Exception:  # noqa: BLE001
        return str(v).strip()


def addrs(v) -> list:
    out = []
    try:
        for name, addr in getaddresses([dec(x) for x in ([v] if isinstance(v, str) else v)] if v else []):
            if addr or name:
                out.append({"n": name.strip().strip('"'), "a": addr.strip().lower()})
    except Exception:  # noqa: BLE001
        pass
    return out


def norm_subject(s: str) -> str:
    return _RE_PREFIX.sub("", s or "").strip().lower()


def _date(msg) -> float:
    for h in ("Date", "Delivery-Date"):
        v = msg.get(h)
        if v:
            try:
                d = parsedate_to_datetime(str(v))
                if d.tzinfo is None:
                    d = d.replace(tzinfo=timezone.utc)
                return d.timestamp()
            except Exception:  # noqa: BLE001
                continue
    return 0.0


def _ids(v) -> list:
    return re.findall(r"<[^<>\s]+>", str(v or ""))


def _payload(part) -> bytes:
    try:
        b = part.get_payload(decode=True)
    except Exception:  # noqa: BLE001
        b = None
    if b is None:
        p = part.get_payload()
        if isinstance(p, str):
            return p.encode("utf-8", "replace")
        if isinstance(p, list) and p and hasattr(p[0], "as_bytes"):  # message/rfc822
            return p[0].as_bytes(policy=email.policy.SMTP)
        return b""
    return b


def _text(part) -> str:
    b = _payload(part)
    cs = part.get_content_charset() or "utf-8"
    try:
        return b.decode(cs, "replace")
    except LookupError:
        return b.decode("utf-8", "replace")


def filename(part) -> str:
    try:
        n = part.get_filename()
    except Exception:  # noqa: BLE001
        n = None
    if not n and part.get_content_type() == "message/rfc822":
        inner = part.get_payload()
        sub = dec(inner[0].get("Subject")) if isinstance(inner, list) and inner else ""
        n = (re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", sub)[:80] or "messaggio") + ".eml"
    return dec(n) if n else ""


def html_to_text(h: str) -> str:
    h = re.sub(r"(?is)<(script|style|head)[^>]*>.*?</\1>", " ", h)
    h = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</h\d>|</li>", "\n", h)
    h = re.sub(r"<[^>]+>", " ", h)
    h = html.unescape(h)
    h = re.sub(r"[ \t\r\f\v ]+", " ", h)
    return re.sub(r"\n\s*\n+", "\n\n", h).strip()


# ---------------------------------------------------------------- struttura delle parti
def walk(msg):
    """Parti foglia con indice stabile (ordine di msg.walk()); i message/rfc822 sono foglie (allegati .eml)."""
    out = []

    def rec(p):
        ct = p.get_content_type()
        if p.is_multipart() and ct != "message/rfc822":
            for sp in p.iter_parts() if hasattr(p, "iter_parts") else p.get_payload():
                rec(sp)
        else:
            out.append(p)
    rec(msg)
    return out


def part_info(msg):
    """(testo, html, allegati, inviti) di un messaggio; allegati = {i, nome, size, tipo, cid, inline}."""
    text = htm = None
    atts, invites = [], []
    for i, p in enumerate(walk(msg)):
        ct = p.get_content_type()
        disp = (p.get_content_disposition() or "").lower()
        fname = filename(p)
        cid = (p.get("Content-ID") or "").strip().strip("<>")
        if ct == "text/calendar":
            invites.append(i)
        if ct == "text/plain" and disp != "attachment" and not fname and text is None:
            text = _text(p)
        elif ct == "text/html" and disp != "attachment" and not fname and htm is None:
            htm = _text(p)
        elif ct in ("application/pkcs7-signature", "application/x-pkcs7-signature") and fname.lower() in ("smime.p7s", ""):
            atts.append({"i": i, "nome": fname or "smime.p7s", "size": len(_payload(p)), "tipo": ct, "cid": "", "inline": False, "firma": True})
        elif ct.startswith("multipart/"):
            continue
        else:
            if not fname and ct == "text/calendar":
                fname = "invito.ics"
            if not fname:
                ext = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "application/pdf": "pdf"}.get(ct, "bin")
                fname = (cid.split("@")[0] if cid else f"parte{i}") + "." + ext
            inline = bool(cid) and ct.startswith("image/") and disp != "attachment"
            atts.append({"i": i, "nome": fname, "size": len(_payload(p)), "tipo": ct, "cid": cid, "inline": inline})
    return text, htm, atts, invites


def part_bytes(msg, idx: int) -> tuple[bytes, str, str]:
    parts = walk(msg)
    if not 0 <= idx < len(parts):
        raise IndexError(idx)
    p = parts[idx]
    return _payload(p), p.get_content_type(), filename(p)


# ---------------------------------------------------------------- PEC
def daticert(xml_bytes: bytes) -> dict:
    """daticert.xml -> dizionario (tipo, errore, mittente, destinatari [{a, tipo}], oggetto, gestore, data, id, msgid, consegna...)."""
    try:
        txt = xml_bytes.decode("utf-8")
    except UnicodeDecodeError:
        txt = xml_bytes.decode("latin-1")
    txt = re.sub(r"<!DOCTYPE[^>]*>", "", txt)
    root = ET.fromstring(txt.encode("utf-8"))
    g = lambda path: (root.findtext(path) or "").strip()  # noqa: E731
    dests = [{"a": (d.text or "").strip().lower(), "tipo": d.get("tipo", "")} for d in root.findall("intestazione/destinatari")]
    data = root.find("dati/data")
    when = ""
    if data is not None:
        when = f"{(data.findtext('giorno') or '').strip()} {(data.findtext('ora') or '').strip()} {data.get('zona', '')}".strip()
    ric = root.find("dati/ricevuta")
    return {"tipo": root.get("tipo", ""), "errore": root.get("errore", ""), "mittente": g("intestazione/mittente").lower(),
            "destinatari": dests, "risposte": g("intestazione/risposte"), "oggetto": g("intestazione/oggetto"),
            "gestore": g("dati/gestore-emittente"), "data": when, "id": g("dati/identificativo"), "msgid": g("dati/msgid"),
            "ricevuta": ric.get("tipo", "") if ric is not None else "", "consegna": g("dati/consegna").lower(),
            "errore_esteso": g("dati/errore-esteso")}


def _unwrap_opaque(msg):
    """Busta S/MIME opaca (application/pkcs7-mime): il contenuto firmato e' dentro la struttura CMS."""
    try:
        from asn1crypto import cms
        ci = cms.ContentInfo.load(_payload(msg))
        content = ci["content"]["encap_content_info"]["content"].native
        return msg_from_bytes(content) if content else None
    except Exception:  # noqa: BLE001
        return None


def pec_info(msg) -> dict | None:
    """Riconosce una busta PEC e ne estrae daticert, postacert.eml e la firma del gestore."""
    xt = (msg.get("X-Trasporto") or "").strip().lower()
    xr = (msg.get("X-Ricevuta") or "").strip().lower()
    if msg.get_content_type() in ("application/pkcs7-mime", "application/x-pkcs7-mime"):
        inner = _unwrap_opaque(msg)
        if inner is not None:
            for h in ("X-Trasporto", "X-Ricevuta", "X-Riferimento-Message-ID", "Subject", "From", "To", "Date"):
                if msg.get(h) and not inner.get(h):
                    inner[h] = msg.get(h)
            msg = inner
    dc = post = None
    dc_i = post_i = sig_i = -1
    for i, p in enumerate(walk(msg)):
        fn = filename(p).lower()
        ct = p.get_content_type()
        if fn == "daticert.xml" or (ct in ("application/xml", "text/xml") and dc is None and b"<postacert" in _payload(p)[:400]):
            try:
                dc, dc_i = daticert(_payload(p)), i
            except Exception:  # noqa: BLE001
                pass
        elif fn == "postacert.eml" or (ct == "message/rfc822" and post is None and fn.startswith("postacert")):
            post_i = i
            inner = p.get_payload()
            post = inner[0] if isinstance(inner, list) and inner else None
        elif ct in ("application/pkcs7-signature", "application/x-pkcs7-signature"):
            sig_i = i
    tipo = xr or (xt if xt in ("posta-certificata", "errore") else "") or (dc or {}).get("tipo", "")
    if xt == "errore" and not xr:
        tipo = "anomalia"
    if not tipo and not dc:
        return None
    return {"tipo": tipo, "daticert": dc, "dc_i": dc_i, "post": post, "post_i": post_i, "sig_i": sig_i,
            "ref": (msg.get("X-Riferimento-Message-ID") or (dc or {}).get("msgid") or "").strip(),
            "ricevuta": (msg.get("X-TipoRicevuta") or (dc or {}).get("ricevuta") or "").strip().lower(),
            "virus": (msg.get("X-VerificaSicurezza") or "").strip().lower() == "errore"}


# ---------------------------------------------------------------- riepilogo per l'indice
def summarize(raw: bytes, header_only=False) -> dict:
    msg = msg_from_bytes(raw)
    s = {"msgid": (_ids(msg.get("Message-ID")) or [""])[0], "in_reply_to": (_ids(msg.get("In-Reply-To")) or [""])[0],
         "refs": " ".join(_ids(msg.get("References"))), "subject": dec(msg.get("Subject")),
         "date": _date(msg), "to": addrs(msg.get_all("To") or []), "cc": addrs(msg.get_all("Cc") or []),
         "priority": _priority(msg)}
    fn, fa = parseaddr(dec(msg.get("From")))
    s["from_name"], s["from_addr"] = fn.strip().strip('"'), fa.lower()
    s["pec"], s["pec_ref"], s["pec_json"] = "", "", ""
    xr = (msg.get("X-Ricevuta") or "").strip().lower()
    xt = (msg.get("X-Trasporto") or "").strip().lower()
    if xr or xt:
        s["pec"] = xr or ("posta-certificata" if xt == "posta-certificata" else "anomalia")
        s["pec_ref"] = (msg.get("X-Riferimento-Message-ID") or "").strip()
    if header_only:
        s.update(has_att=int("multipart/mixed" in (msg.get("Content-Type") or "").lower()), preview="", body="", atts=[], invite=0)
        return s
    pec = pec_info(msg)
    view = msg
    if pec:
        s["pec"] = pec["tipo"]
        s["pec_ref"] = pec["ref"] or s["pec_ref"]
        dc = pec["daticert"] or {}
        s["pec_json"] = __import__("json").dumps(dc, ensure_ascii=False) if dc else ""
        if pec["tipo"] == "posta-certificata" and pec["post"] is not None:
            view = pec["post"]  # in elenco e in lettura il messaggio originale
            s["subject"] = dec(view.get("Subject")) or s["subject"]
            vn, va = parseaddr(dec(view.get("From")))
            s["from_name"], s["from_addr"] = vn.strip().strip('"') or s["from_name"], (va or dc.get("mittente") or s["from_addr"]).lower()
            if dc.get("msgid"):
                s["orig_msgid"] = dc["msgid"]
    text, htm, atts, invites = part_info(view)
    body = text if text and text.strip() else (html_to_text(htm) if htm else "")
    visible = [a for a in atts if not a["inline"] and not a.get("firma")]
    s["atts"] = [{"nome": a["nome"], "size": a["size"], "tipo": a["tipo"]} for a in visible]
    s["has_att"] = int(bool(visible))
    s["body"] = body[:65536]
    s["preview"] = re.sub(r"\s+", " ", body[:600]).strip()[:220]
    s["invite"] = int(bool(invites))
    return s


def _priority(msg) -> int:
    v = str(msg.get("X-Priority") or msg.get("Importance") or "").lower()
    if v.startswith(("1", "2")) or "high" in v:
        return 1
    if v.startswith(("4", "5")) or "low" in v:
        return -1
    return 0


# ---------------------------------------------------------------- contenuto per la lettura
def render(raw: bytes) -> dict:
    msg = msg_from_bytes(raw)
    pec = pec_info(msg)
    view, base = msg, ""
    if pec and pec["tipo"] == "posta-certificata" and pec["post"] is not None:
        view = pec["post"]
        base = f"{pec['post_i']}."  # parti del messaggio interno: "<indice postacert>.<indice interno>"
    text, htm, atts, invites = part_info(view)
    for a in atts:
        a["i"] = f"{base}{a['i']}"
    hd = {"subject": dec(view.get("Subject")), "from": addrs(view.get_all("From") or []), "to": addrs(view.get_all("To") or []),
          "cc": addrs(view.get_all("Cc") or []), "reply_to": addrs(view.get_all("Reply-To") or []),
          "date": _date(view) or _date(msg), "msgid": (_ids(view.get("Message-ID")) or [""])[0],
          "refs": " ".join(_ids(view.get("References"))), "priority": _priority(view),
          "notify": dec(view.get("Disposition-Notification-To"))}
    out = {"ok": True, "h": hd, "text": text or "", "html": htm or "", "atts": atts, "pec": None, "inviti": [f"{base}{i}" for i in invites]}
    if pec:
        envelope = []
        if pec["dc_i"] >= 0:
            envelope.append({"i": str(pec["dc_i"]), "nome": "daticert.xml", "tipo": "application/xml"})
        if pec["post_i"] >= 0:
            envelope.append({"i": str(pec["post_i"]), "nome": "postacert.eml", "tipo": "message/rfc822"})
        if pec["sig_i"] >= 0:
            envelope.append({"i": str(pec["sig_i"]), "nome": "smime.p7s", "tipo": "application/pkcs7-signature"})
        gtext, ghtml, _, _ = part_info(msg) if view is not msg else (None, None, None, None)
        out["pec"] = {"tipo": pec["tipo"], "daticert": pec["daticert"], "ref": pec["ref"], "ricevuta": pec["ricevuta"],
                      "virus": pec["virus"], "busta": envelope, "testo_gestore": (gtext or (html_to_text(ghtml) if ghtml else "")) if view is not msg else "",
                      "oggetto_busta": dec(msg.get("Subject")), "da_busta": dec(msg.get("From"))}
    return out


def get_part(raw: bytes, idx: str) -> tuple[bytes, str, str]:
    """Parte per indice ("3" o "2.1" = parte 1 del messaggio allegato nella parte 2, es. postacert.eml)."""
    msg = msg_from_bytes(raw)
    bits = str(idx).split(".")
    for b in bits[:-1]:
        p = walk(msg)[int(b)]
        inner = p.get_payload()
        msg = inner[0] if isinstance(inner, list) else msg_from_bytes(_payload(p))
    return part_bytes(msg, int(bits[-1]))


def part_by_cid(raw: bytes, cid: str):
    msg = msg_from_bytes(raw)
    pec = pec_info(msg)
    if pec and pec["post"] is not None:
        msg = pec["post"]
    for p in walk(msg):
        if (p.get("Content-ID") or "").strip().strip("<>") == cid:
            return _payload(p), p.get_content_type()
    return None, None


def fmt_date(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else ""
