"""Certificati digitali (X.509 in PEM/DER, PKCS#7 .p7b, PKCS#12 .p12/.pfx, richieste CSR, elenchi di revoca CRL).

Solo dati pubblici: le chiavi private non si leggono ne' si esportano. La password dei PKCS#12 arriva con la singola
richiesta, serve solo a decifrare i certificati e non viene conservata da nessuna parte.
Libreria: cryptography (Apache-2.0 / BSD). Le radici attendibili si confrontano con l'archivio di Windows (modulo ssl).
"""
from __future__ import annotations

import datetime as dt
import re
import ssl
import sys
import warnings

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import dsa, ec, ed448, ed25519, rsa
from cryptography.hazmat.primitives.serialization import pkcs7, pkcs12
from cryptography.x509.oid import ExtensionOID, NameOID
from .i18n import t

def _names():  # testi nella lingua attiva al momento della richiesta
    return {
    "commonName": t("srv_fx_cert.nome_comune_cn"), "organizationName": t("srv_fx_cert.organizzazione"), "organizationalUnitName": t("srv_fx_cert.unita_ou"),
    "countryName": t("srv_fx_cert.paese_c"), "stateOrProvinceName": t("srv_fx_cert.provincia_stato_st"), "localityName": t("srv_fx_cert.localita_l"),
    "emailAddress": t("srv_fx_cert.email"), "serialNumber": t("srv_fx_cert.numero_serie_soggetto"), "givenName": t("common.nome"), "surname": t("srv_fx_cert.cognome"),
    "title": t("srv_fx_cert.titolo"), "organizationIdentifier": t("srv_fx_cert.identificativo_organizzazione"), "dnQualifier": t("srv_fx_cert.qualificatore_dn"),
    "streetAddress": t("srv_fx_cert.indirizzo"), "postalCode": "CAP", "pseudonym": t("srv_fx_cert.pseudonimo"), "domainComponent": t("srv_fx_cert.componente_dominio_dc"),
}
def _eku():  # testi nella lingua attiva al momento della richiesta
    return {
    "serverAuth": t("srv_fx_cert.autenticazione_server_tls"), "clientAuth": t("srv_fx_cert.autenticazione_client"), "codeSigning": t("srv_fx_cert.firma_codice"),
    "emailProtection": t("srv_fx_cert.protezione_email_s_mime"), "timeStamping": t("srv_fx_cert.marca_temporale"), "OCSPSigning": t("srv_fx_cert.firma_ocsp"),
    "smartcardLogon": t("srv_fx_cert.accesso_smart_card"), "documentSigning": t("srv_fx_cert.firma_documenti"), "anyExtendedKeyUsage": t("srv_fx_cert.qualsiasi_uso"),
}
def _ku():  # testi nella lingua attiva al momento della richiesta
    return [("digital_signature", t("srv_fx_cert.firma_digitale")), ("content_commitment", t("srv_fx_cert.non_ripudio")), ("key_encipherment", t("srv_fx_cert.cifratura_chiave")),
      ("data_encipherment", t("srv_fx_cert.cifratura_dati")), ("key_agreement", t("srv_fx_cert.accordo_chiave")), ("key_cert_sign", t("srv_fx_cert.firma_certificati")),
      ("crl_sign", t("srv_fx_cert.firma_crl"))]


def _load_all(data: bytes, password: str | None):
    """-> (certificati, altri oggetti {tipo, ...}, note, serve_password)."""
    certs, others, notes = [], [], []
    text = None
    if b"-----BEGIN" in data[:65536] or data.lstrip()[:5] == b"-----":
        text = data
    if text is not None:
        for m in re.finditer(rb"-----BEGIN ([A-Z0-9 ]+)-----(.*?)-----END \1-----", text, re.S):
            kind, block = m.group(1).decode(), m.group(0)
            try:
                if kind in ("CERTIFICATE", "X509 CERTIFICATE", "TRUSTED CERTIFICATE"):
                    certs.append(x509.load_pem_x509_certificate(block.replace(b"TRUSTED CERTIFICATE", b"CERTIFICATE")))
                elif kind in ("PKCS7", "CMS"):
                    certs.extend(pkcs7.load_pem_pkcs7_certificates(block))
                elif kind in ("X509 CRL",):
                    others.append(("crl", x509.load_pem_x509_crl(block)))
                elif kind in ("CERTIFICATE REQUEST", "NEW CERTIFICATE REQUEST"):
                    others.append(("csr", x509.load_pem_x509_csr(block.replace(b"NEW CERTIFICATE REQUEST", b"CERTIFICATE REQUEST"))))
                elif kind == "PUBLIC KEY":
                    others.append(("pub", serialization.load_pem_public_key(block)))
                elif "PRIVATE KEY" in kind:
                    notes.append(t("srv_fx_cert.file_contiene_anche_chiave_privata"))
            except Exception as e:  # noqa: BLE001
                notes.append(t("srv_fx_cert.blocco_0_non_leggibile_1", kind, e))
        return certs, others, notes, False
    # binario (DER): certificato, PKCS#7, CRL, CSR, poi PKCS#12
    for fn in (lambda d: [x509.load_der_x509_certificate(d)], pkcs7.load_der_pkcs7_certificates):
        try:
            return list(fn(data)), others, notes, False
        except Exception:
            pass
    for kind, fn in (("crl", x509.load_der_x509_crl), ("csr", x509.load_der_x509_csr)):
        try:
            return certs, [(kind, fn(data))], notes, False
        except Exception:
            pass
    tries = [password.encode("utf-8")] if password is not None else [None, b""]
    last = None
    for pw in tries:
        try:
            key, cert, extra = pkcs12.load_key_and_certificates(data, pw)
            if key is not None:
                notes.append(t("srv_fx_cert.file_pkcs_12_contiene_chiave"))
            out = ([cert] if cert else []) + list(extra or [])
            if not out:
                notes.append(t("srv_fx_cert.file_pkcs_12_non_contiene"))
            return out, others, notes, False
        except ValueError as e:
            last = e
        except Exception as e:  # noqa: BLE001
            last = e
    if _looks_pkcs12(data):
        return [], [], [], True if password is None else "errata"
    raise ValueError(t("srv_fx_cert.formato_non_riconosciuto_come_certificato", last))


def _looks_pkcs12(data: bytes) -> bool:
    # SEQUENCE { INTEGER 3, SEQUENCE { OID pkcs7-data ... } }
    return data[:1] == b"\x30" and b"\x02\x01\x03" in data[:12] and b"\x2a\x86\x48\x86\xf7\x0d\x01\x07\x01" in data[:40]


def _name(n: x509.Name) -> list:
    out = []
    for a in n:
        key = getattr(a.oid, "_name", None) or a.oid.dotted_string
        out.append({"campo": _names().get(key, key), "valore": a.value if isinstance(a.value, str) else a.value.hex()})
    return out


def _cn(n: x509.Name) -> str:
    for oid in (NameOID.COMMON_NAME, NameOID.ORGANIZATION_NAME, NameOID.ORGANIZATIONAL_UNIT_NAME):
        v = n.get_attributes_for_oid(oid)
        if v:
            return v[0].value
    return n.rfc4514_string()


def _key(k) -> str:
    if isinstance(k, rsa.RSAPublicKey):
        return t("srv_fx_cert.rsa_0_bit", k.key_size)
    if isinstance(k, ec.EllipticCurvePublicKey):
        return t("srv_fx_cert.curva_ellittica_0_1_bit", k.curve.name, k.key_size)
    if isinstance(k, dsa.DSAPublicKey):
        return t("srv_fx_cert.dsa_0_bit", k.key_size)
    if isinstance(k, ed25519.Ed25519PublicKey):
        return "Ed25519"
    if isinstance(k, ed448.Ed448PublicKey):
        return "Ed448"
    return type(k).__name__


def _when(d: dt.datetime) -> str:
    return d.astimezone().strftime("%d/%m/%Y %H:%M")


def _gn(g) -> str:
    v = getattr(g, "value", g)
    label = {"DNSName": "DNS", "RFC822Name": t("srv_fx_cert.email"), "UniformResourceIdentifier": "URI", "IPAddress": "IP",
             "DirectoryName": t("common.nome"), "OtherName": t("srv_fx_cert.altro")}.get(type(g).__name__, type(g).__name__)
    if isinstance(v, x509.Name):
        v = v.rfc4514_string()
    elif isinstance(v, bytes):
        v = v.hex()
    elif type(g).__name__ == "OtherName":
        v = f"{g.type_id.dotted_string}: {g.value.hex()}"
    return f"{label}: {v}"


def _ext(e: x509.Extension) -> dict:
    v = e.value
    name = getattr(e.oid, "_name", e.oid.dotted_string)
    txt = None
    try:
        if isinstance(v, x509.KeyUsage):
            usi = [lbl for attr, lbl in _ku() if getattr(v, attr)]
            if v.key_agreement:
                usi += [lbl for attr, lbl in (("encipher_only", t("srv_fx_cert.solo_cifratura")), ("decipher_only", t("srv_fx_cert.solo_decifratura"))) if getattr(v, attr)]
            name, txt = t("srv_fx_cert.uso_chiave"), ", ".join(usi)
        elif isinstance(v, x509.ExtendedKeyUsage):
            name, txt = t("srv_fx_cert.uso_esteso_chiave"), ", ".join(_eku().get(getattr(o, "_name", ""), getattr(o, "_name", o.dotted_string)) for o in v)
        elif isinstance(v, x509.BasicConstraints):
            name, txt = t("srv_fx_cert.vincoli_base"), (t("srv_fx_cert.autorita_certificazione_ca") + (t("srv_fx_cert.profondita_massima_0", v.path_length) if v.path_length is not None else "")) if v.ca else t("srv_fx_cert.certificato_finale_non_ca")
        elif isinstance(v, x509.SubjectAlternativeName):
            name, txt = t("srv_fx_cert.nomi_alternativi_soggetto"), "\n".join(_gn(g) for g in v)
        elif isinstance(v, x509.IssuerAlternativeName):
            name, txt = t("srv_fx_cert.nomi_alternativi_dell_emittente"), "\n".join(_gn(g) for g in v)
        elif isinstance(v, x509.SubjectKeyIdentifier):
            name, txt = t("srv_fx_cert.identificativo_chiave_soggetto"), v.digest.hex(":")
        elif isinstance(v, x509.AuthorityKeyIdentifier):
            name, txt = t("srv_fx_cert.identificativo_chiave_dell_emittente"), (v.key_identifier or b"").hex(":")
        elif isinstance(v, x509.CRLDistributionPoints):
            name, txt = t("srv_fx_cert.punti_distribuzione_crl"), "\n".join(_gn(g) for dp in v for g in (dp.full_name or []))
        elif isinstance(v, x509.AuthorityInformationAccess):
            name, txt = t("srv_fx_cert.accesso_alle_informazioni_dell_autorita"), "\n".join(
                ("OCSP" if d.access_method.dotted_string.endswith(".1") else t("srv_fx_cert.certificato_emittente")) + ": " + _gn(d.access_location).split(": ", 1)[-1] for d in v)
        elif isinstance(v, x509.CertificatePolicies):
            name, txt = t("srv_fx_cert.politiche_certificato"), "\n".join(p.policy_identifier.dotted_string + "".join(
                f"  ({q})" if isinstance(q, str) else "" for q in (p.policy_qualifiers or [])) for p in v)
        elif e.oid.dotted_string == "1.3.6.1.5.5.7.1.3":
            name, txt = t("srv_fx_cert.dichiarazioni_certificato_qualificato_qc_eidas"), v.value.hex() if hasattr(v, "value") else str(v)
        else:
            txt = v.value.hex() if isinstance(v, x509.UnrecognizedExtension) else str(v)
    except Exception as ex:  # noqa: BLE001
        txt = t("srv_fx_cert.non_leggibile_0", ex)
    return {"nome": name, "oid": e.oid.dotted_string, "critica": e.critical, "valore": txt}


def _cert(c: x509.Certificate) -> dict:
    now = dt.datetime.now(dt.timezone.utc)
    a, b = c.not_valid_before_utc, c.not_valid_after_utc
    try:
        exts = [_ext(e) for e in c.extensions]
    except Exception as e:  # noqa: BLE001
        exts = [{"nome": t("srv_fx_cert.estensioni"), "oid": "", "critica": False, "valore": t("srv_fx_cert.non_leggibili_0", e)}]
    try:
        bc = c.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS).value.ca
    except Exception:
        bc = False
    usi = next((e["valore"] for e in exts if e["oid"] == "2.5.29.15"), "")
    eku = next((e["valore"] for e in exts if e["oid"] == "2.5.29.37"), "")
    try:
        sig = c.signature_algorithm_oid._name
    except Exception:
        sig = c.signature_algorithm_oid.dotted_string
    return {
        "nome": _cn(c.subject), "emittente_nome": _cn(c.issuer),
        "soggetto": _name(c.subject), "emittente": _name(c.issuer),
        "soggetto_dn": c.subject.rfc4514_string(), "emittente_dn": c.issuer.rfc4514_string(),
        "valido_dal": _when(a), "valido_al": _when(b), "scaduto": now > b, "non_ancora_valido": now < a,
        "giorni_rimasti": (b - now).days,
        "seriale": format(c.serial_number, "X"), "versione": c.version.name.replace("v", "v"),
        "algoritmo_firma": sig, "chiave": _key(c.public_key()),
        "sha1": c.fingerprint(hashes.SHA1()).hex(":").upper(), "sha256": c.fingerprint(hashes.SHA256()).hex(":").upper(),
        "pem": c.public_bytes(serialization.Encoding.PEM).decode("ascii"),
        "ca": bc, "autofirmato": c.subject == c.issuer, "usi": usi, "usi_estesi": eku, "estensioni": exts,
    }


def _issued_by(child: x509.Certificate, parent: x509.Certificate) -> bool:
    if child.issuer != parent.subject:
        return False
    try:
        child.verify_directly_issued_by(parent)
        return True
    except Exception:
        return False


_STORE = None


def _windows_store() -> list:
    """Certificati delle autorita' di Windows (radici e intermedie), letti una volta sola."""
    global _STORE
    if _STORE is None:
        _STORE = []
        if sys.platform == "win32":
            with warnings.catch_warnings():  # certificati di sistema con seriale negativo: solo avvisi di cryptography
                warnings.simplefilter("ignore")
                for store in ("ROOT", "CA"):
                    try:
                        for der, enc, _trust in ssl.enum_certificates(store):
                            if enc == "x509_asn":
                                try:
                                    _STORE.append((store, x509.load_der_x509_certificate(der)))
                                except Exception:
                                    pass
                    except Exception:
                        pass
    return _STORE


def _chains(certs: list) -> list:
    """Catene dal certificato finale verso la radice: prima con i certificati del file, poi con quelli di Windows."""
    issued = {i for i, c in enumerate(certs) for j, p in enumerate(certs) if i != j and _issued_by(p, c)}
    leaves = [i for i in range(len(certs)) if i not in issued] or [0]
    out = []
    for leaf in leaves:
        chain, cur, seen = [], certs[leaf], set()
        chain.append({"indice": leaf, "nome": _cn(cur.subject), "fonte": "file"})
        while cur.subject != cur.issuer and len(chain) < 12:
            nxt = next((j for j, p in enumerate(certs) if j not in seen and p is not cur and _issued_by(cur, p)), None)
            if nxt is not None:
                seen.add(nxt)
                cur = certs[nxt]
                chain.append({"indice": nxt, "nome": _cn(cur.subject), "fonte": "file"})
                continue
            win = next(((s, p) for s, p in _windows_store() if _issued_by(cur, p)), None)
            if win:
                cur = win[1]
                chain.append({"indice": None, "nome": _cn(cur.subject), "fonte": "windows-" + win[0].lower(),
                              "valido_al": _when(cur.not_valid_after_utc)})
                continue
            chain.append({"indice": None, "nome": _cn(cur.issuer), "fonte": "mancante"})
            break
        top = chain[-1]
        root_ok = top["fonte"] == "windows-root" or (top["fonte"] == "file" and top["indice"] is not None and any(
            p.fingerprint(hashes.SHA256()) == certs[top["indice"]].fingerprint(hashes.SHA256()) for s, p in _windows_store() if s == "ROOT"))
        out.append({"anelli": chain, "radice_attendibile": root_ok, "completa": top["fonte"] != "mancante"})
    return out


def read(path: str, password: str | None = None) -> dict:
    data = open(path, "rb").read()
    certs, others, notes, need = _load_all(data, password)
    if need:
        return {"ok": True, "password_richiesta": True, "errata": need == "errata"}
    res = {"ok": True, "certificati": [_cert(c) for c in certs], "note": notes, "altri": []}
    if certs:
        res["catene"] = _chains(certs)
    for kind, o in others:
        if kind == "crl":
            res["altri"].append({"tipo": t("srv_fx_cert.elenco_revoca_crl"), "emittente": _name(o.issuer), "emittente_nome": _cn(o.issuer),
                                 "aggiornato": _when(o.last_update_utc) if o.last_update_utc else "",
                                 "prossimo": _when(o.next_update_utc) if o.next_update_utc else "",
                                 "revocati": [{"seriale": format(r.serial_number, "X"), "data": _when(r.revocation_date_utc)} for r in list(o)[:5000]],
                                 "estensioni": [_ext(e) for e in o.extensions]})
        elif kind == "csr":
            res["altri"].append({"tipo": t("srv_fx_cert.richiesta_certificato_csr"), "soggetto": _name(o.subject), "soggetto_nome": _cn(o.subject),
                                 "chiave": _key(o.public_key()), "firma_valida": o.is_signature_valid,
                                 "estensioni": [_ext(e) for e in o.extensions]})
        elif kind == "pub":
            res["altri"].append({"tipo": t("srv_fx_cert.chiave_pubblica"), "chiave": _key(o)})
    if not certs and not others:
        raise ValueError(t("srv_fx_cert.nessun_certificato_trovato_file"))
    return res


def export(pems: list, out: str, indice=None) -> dict:
    """Esporta i certificati gia' letti (solo parti pubbliche, in PEM): nessuna password serve qui."""
    certs = [x509.load_pem_x509_certificate(p.encode("ascii")) for p in pems]
    if not certs:
        raise ValueError(t("srv_fx_cert.file_non_contiene_certificati_esportare"))
    ext = out.rsplit(".", 1)[-1].lower()
    sel = certs[int(indice)] if indice is not None and 0 <= int(indice) < len(certs) else certs[0]
    if ext == "pem":
        blob = b"".join(c.public_bytes(serialization.Encoding.PEM) for c in certs)
    elif ext == "crt":
        blob = sel.public_bytes(serialization.Encoding.PEM)
    elif ext in ("der", "cer"):
        blob = sel.public_bytes(serialization.Encoding.DER)
    elif ext == "p7b":
        blob = pkcs7.serialize_certificates(certs, serialization.Encoding.DER)
    elif ext == "txt":
        blob = summary_text({"certificati": [_cert(c) for c in certs], "catene": _chains(certs)}).encode("utf-8")
    else:
        raise ValueError(t("srv_fx_cert.formato_esportazione_non_previsto_0", ext))
    with open(out, "wb") as f:
        f.write(blob)
    return {"ok": True, "path": out}


def summary_text(r: dict) -> str:
    lines = []
    for i, c in enumerate(r.get("certificati", [])):
        lines += [t("srv_fx_cert.certificato_0_1", i + 1, c['nome']), t("srv_fx_cert.soggetto_0", c['soggetto_dn']), t("srv_fx_cert.emittente_0", c['emittente_dn']),
                  t("srv_fx_cert.valido_0_1", c['valido_dal'], c['valido_al']) + (t("srv_fx_cert.scaduto") if c["scaduto"] else ""),
                  t("srv_fx_cert.numero_serie_0", c['seriale']), t("srv_fx_cert.chiave_0", c['chiave']), t("srv_fx_cert.algoritmo_firma_0", c['algoritmo_firma']),
                  f"SHA-1: {c['sha1']}", f"SHA-256: {c['sha256']}"]
        for e in c["estensioni"]:
            lines.append(f"{e['nome']}{' (critica)' if e['critica'] else ''}: {str(e['valore']).replace(chr(10), '; ')}")
        lines.append("")
    for ch in r.get("catene", []):
        lines.append(t("srv_fx_cert.catena") + "  ->  ".join(a["nome"] for a in ch["anelli"]) + (t("srv_fx_cert.radice_attendibile_windows") if ch["radice_attendibile"] else ""))
    return "\n".join(lines) + "\n"
