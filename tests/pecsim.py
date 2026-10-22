"""Simulatore di un gestore PEC per le prove: buste "posta certificata", ricevute di accettazione, avvenuta consegna,
errore di consegna e non accettazione con daticert.xml e firma S/MIME del gestore (certificato di prova generato al momento).
Struttura come nelle regole tecniche (DM 2/11/2005): multipart/signed { multipart/mixed { multipart/alternative
{testo, html}, daticert.xml, [postacert.eml] }, smime.p7s }.
"""
import datetime as dt
import uuid
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from xml.sax.saxutils import escape

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs7
from cryptography.x509.oid import NameOID

GESTORE = "Gestore PEC di Prova S.p.A."
DOMINIO = "pec.prova.it"
_CERT = {}


def _cert():
    if not _CERT:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME, "IT"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, GESTORE),
                          x509.NameAttribute(NameOID.COMMON_NAME, "posta-certificata@" + DOMINIO)])
        now = dt.datetime.now(dt.timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1))
                .not_valid_after(now + dt.timedelta(days=365))
                .add_extension(x509.SubjectAlternativeName([x509.RFC822Name("posta-certificata@" + DOMINIO)]), critical=False)
                .sign(key, hashes.SHA256()))
        _CERT.update(key=key, cert=cert)
    return _CERT["key"], _CERT["cert"]


def _now():
    n = dt.datetime.now().astimezone()
    return n, n.strftime("%d/%m/%Y"), n.strftime("%H:%M:%S"), n.strftime("%z")


def daticert(tipo, mittente, destinatari, oggetto, msgid, consegna="", errore="nessuno", errore_esteso="", ricevuta="completa"):
    _, giorno, ora, zona = _now()
    dest = "".join(f'<destinatari tipo="{"certificato" if d.endswith(DOMINIO) else "esterno"}">{escape(d)}</destinatari>' for d in destinatari)
    extra = f"<consegna>{escape(consegna)}</consegna>" if consegna else ""
    if errore_esteso:
        extra += f"<errore-esteso>{escape(errore_esteso)}</errore-esteso>"
    if tipo == "avvenuta-consegna":
        extra = f'<ricevuta tipo="{ricevuta}"/>' + extra
    ident = f"opec{uuid.uuid4().hex[:20]}@{DOMINIO}"
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<postacert tipo="{tipo}" errore="{errore}"><intestazione>'
            f"<mittente>{escape(mittente)}</mittente>{dest}<risposte>{escape(mittente)}</risposte><oggetto>{escape(oggetto)}</oggetto>"
            f"</intestazione><dati><gestore-emittente>{GESTORE}</gestore-emittente><data zona=\"{zona}\"><giorno>{giorno}</giorno>"
            f"<ora>{ora}</ora></data><identificativo>{ident}</identificativo><msgid>{escape(msgid)}</msgid>{extra}</dati></postacert>").encode()


def _sign(inner: EmailMessage, headers: dict) -> bytes:
    key, cert = _cert()
    body = inner.as_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    signed = (pkcs7.PKCS7SignatureBuilder().set_data(body).add_signer(cert, key, hashes.SHA256())
              .sign(serialization.Encoding.SMIME, [pkcs7.PKCS7Options.DetachedSignature]))
    head = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
    return head.encode("utf-8") + signed.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def _mixed(text, html, dc: bytes, original: bytes | None):
    m = EmailMessage()
    m.set_content(text)
    m.add_alternative(html, subtype="html")
    m.make_mixed()
    m.add_attachment(dc, maintype="application", subtype="xml", filename="daticert.xml")
    if original is not None:
        from email import message_from_bytes, policy
        m.add_attachment(message_from_bytes(original, policy=policy.default), filename="postacert.eml")
    del m["MIME-Version"]
    return m


def _base_headers(subject, frm, to, extra):
    h = {"Date": formatdate(localtime=True), "Message-ID": make_msgid(domain=DOMINIO), "Subject": subject,
         "From": frm, "To": to}
    h.update(extra)
    return h


def busta(original: bytes, mittente, destinatari, oggetto, msgid, to_hdr) -> bytes:
    """Messaggio di posta certificata consegnato al destinatario."""
    _, giorno, ora, _ = _now()
    text = (f"Messaggio di posta certificata\n\nIl giorno {giorno} alle ore {ora} il messaggio\n\"{oggetto}\" e' stato inviato da \"{mittente}\"\n"
            f"indirizzato a:\n" + "\n".join(destinatari) + "\nIl testo originale si trova nell'allegato postacert.eml.\n")
    html = "<p>" + escape(text).replace("\n", "<br>") + "</p>"
    dc = daticert("posta-certificata", mittente, destinatari, oggetto, msgid)
    inner = _mixed(text, html, dc, original)
    return _sign(inner, _base_headers(f"POSTA CERTIFICATA: {oggetto}", formataddr((f"Per conto di: {mittente}", "posta-certificata@" + DOMINIO)),
                                      to_hdr, {"Reply-To": mittente, "X-Trasporto": "posta-certificata", "X-Riferimento-Message-ID": msgid}))


def ricevuta(tipo, original: bytes | None, mittente, destinatari, oggetto, msgid, consegna="", errore="nessuno", errore_esteso="") -> bytes:
    _, giorno, ora, _ = _now()
    titoli = {"accettazione": "ACCETTAZIONE", "non-accettazione": "AVVISO DI NON ACCETTAZIONE", "avvenuta-consegna": "CONSEGNA",
              "errore-consegna": "AVVISO DI MANCATA CONSEGNA", "preavviso-errore-consegna": "AVVISO DI MANCATA CONSEGNA PER SUP. TEMPO MASSIMO"}
    testi = {"accettazione": f"Il giorno {giorno} alle ore {ora} il messaggio \"{oggetto}\" proveniente da \"{mittente}\" ed indirizzato a:\n"
                             + "\n".join(destinatari) + "\ne' stato accettato dal sistema ed inoltrato.",
             "avvenuta-consegna": f"Il giorno {giorno} alle ore {ora} il messaggio \"{oggetto}\" proveniente da \"{mittente}\" ed indirizzato a "
                                  f"\"{consegna}\" e' stato consegnato nella casella di destinazione.",
             "errore-consegna": f"Il giorno {giorno} alle ore {ora} nel messaggio \"{oggetto}\" proveniente da \"{mittente}\" ed indirizzato a "
                                f"\"{consegna}\" e' stato rilevato un problema che ne impedisce la consegna a causa di {errore_esteso}.",
             "non-accettazione": f"Il giorno {giorno} alle ore {ora} nel messaggio \"{oggetto}\" proveniente da \"{mittente}\" e' stato rilevato "
                                 f"un problema che ne impedisce l'accettazione a causa di {errore_esteso}."}
    text = testi.get(tipo, tipo)
    dc = daticert(tipo, mittente, destinatari, oggetto, msgid, consegna, errore, errore_esteso)
    inner = _mixed(text, "<p>" + escape(text).replace("\n", "<br>") + "</p>", dc, original if tipo == "avvenuta-consegna" else None)
    return _sign(inner, _base_headers(f"{titoli.get(tipo, tipo.upper())}: {oggetto}", formataddr(("posta-certificata@" + DOMINIO, "posta-certificata@" + DOMINIO)),
                                      mittente, {"X-Ricevuta": tipo, "X-Riferimento-Message-ID": msgid,
                                                 **({"X-TipoRicevuta": "completa"} if tipo == "avvenuta-consegna" else {})}))
