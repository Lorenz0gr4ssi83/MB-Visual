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

NAMES = {
    "commonName": "Nome comune (CN)", "organizationName": "Organizzazione (O)", "organizationalUnitName": "Unita' (OU)",
    "countryName": "Paese (C)", "stateOrProvinceName": "Provincia/Stato (ST)", "localityName": "Localita' (L)",
    "emailAddress": "Email", "serialNumber": "Numero di serie del soggetto", "givenName": "Nome", "surname": "Cognome",
    "title": "Titolo", "organizationIdentifier": "Identificativo organizzazione", "dnQualifier": "Qualificatore DN",
    "streetAddress": "Indirizzo", "postalCode": "CAP", "pseudonym": "Pseudonimo", "domainComponent": "Componente di dominio (DC)",
}
EKU = {
    "serverAuth": "Autenticazione server (TLS)", "clientAuth": "Autenticazione client", "codeSigning": "Firma del codice",
    "emailProtection": "Protezione email (S/MIME)", "timeStamping": "Marca temporale", "OCSPSigning": "Firma OCSP",
    "smartcardLogon": "Accesso con smart card", "documentSigning": "Firma di documenti", "anyExtendedKeyUsage": "Qualsiasi uso",
}
KU = [("digital_signature", "Firma digitale"), ("content_commitment", "Non ripudio"), ("key_encipherment", "Cifratura della chiave"),
      ("data_encipherment", "Cifratura dei dati"), ("key_agreement", "Accordo di chiave"), ("key_cert_sign", "Firma di certificati"),
      ("crl_sign", "Firma di CRL")]


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
                    notes.append("Il file contiene anche una chiave privata: non viene letta ne' mostrata.")
            except Exception as e:  # noqa: BLE001
                notes.append(f"Blocco {kind} non leggibile: {e}")
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
                notes.append("Il file PKCS#12 contiene una chiave privata: non viene letta, mostrata o esportata.")
            out = ([cert] if cert else []) + list(extra or [])
            if not out:
                notes.append("Il file PKCS#12 non contiene certificati.")
            return out, others, notes, False
        except ValueError as e:
            last = e
        except Exception as e:  # noqa: BLE001
            last = e
    if _looks_pkcs12(data):
        return [], [], [], True if password is None else "errata"
    raise ValueError(f"Formato non riconosciuto come certificato ({last})")


def _looks_pkcs12(data: bytes) -> bool:
    # SEQUENCE { INTEGER 3, SEQUENCE { OID pkcs7-data ... } }
    return data[:1] == b"\x30" and b"\x02\x01\x03" in data[:12] and b"\x2a\x86\x48\x86\xf7\x0d\x01\x07\x01" in data[:40]


def _name(n: x509.Name) -> list:
    out = []
    for a in n:
        key = getattr(a.oid, "_name", None) or a.oid.dotted_string
        out.append({"campo": NAMES.get(key, key), "valore": a.value if isinstance(a.value, str) else a.value.hex()})
    return out


def _cn(n: x509.Name) -> str:
    for oid in (NameOID.COMMON_NAME, NameOID.ORGANIZATION_NAME, NameOID.ORGANIZATIONAL_UNIT_NAME):
        v = n.get_attributes_for_oid(oid)
        if v:
            return v[0].value
    return n.rfc4514_string()


def _key(k) -> str:
    if isinstance(k, rsa.RSAPublicKey):
        return f"RSA {k.key_size} bit"
    if isinstance(k, ec.EllipticCurvePublicKey):
        return f"Curva ellittica {k.curve.name} ({k.key_size} bit)"
    if isinstance(k, dsa.DSAPublicKey):
        return f"DSA {k.key_size} bit"
    if isinstance(k, ed25519.Ed25519PublicKey):
        return "Ed25519"
    if isinstance(k, ed448.Ed448PublicKey):
        return "Ed448"
    return type(k).__name__


def _when(d: dt.datetime) -> str:
    return d.astimezone().strftime("%d/%m/%Y %H:%M")


def _gn(g) -> str:
    v = getattr(g, "value", g)
    label = {"DNSName": "DNS", "RFC822Name": "Email", "UniformResourceIdentifier": "URI", "IPAddress": "IP",
             "DirectoryName": "Nome", "OtherName": "Altro"}.get(type(g).__name__, type(g).__name__)
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
            usi = [lbl for attr, lbl in KU if getattr(v, attr)]
            if v.key_agreement:
                usi += [lbl for attr, lbl in (("encipher_only", "Solo cifratura"), ("decipher_only", "Solo decifratura")) if getattr(v, attr)]
            name, txt = "Uso della chiave", ", ".join(usi)
        elif isinstance(v, x509.ExtendedKeyUsage):
            name, txt = "Uso esteso della chiave", ", ".join(EKU.get(getattr(o, "_name", ""), getattr(o, "_name", o.dotted_string)) for o in v)
        elif isinstance(v, x509.BasicConstraints):
            name, txt = "Vincoli di base", ("Autorita' di certificazione (CA)" + (f", profondita' massima {v.path_length}" if v.path_length is not None else "")) if v.ca else "Certificato finale (non CA)"
        elif isinstance(v, x509.SubjectAlternativeName):
            name, txt = "Nomi alternativi del soggetto", "\n".join(_gn(g) for g in v)
        elif isinstance(v, x509.IssuerAlternativeName):
            name, txt = "Nomi alternativi dell'emittente", "\n".join(_gn(g) for g in v)
        elif isinstance(v, x509.SubjectKeyIdentifier):
            name, txt = "Identificativo chiave del soggetto", v.digest.hex(":")
        elif isinstance(v, x509.AuthorityKeyIdentifier):
            name, txt = "Identificativo chiave dell'emittente", (v.key_identifier or b"").hex(":")
        elif isinstance(v, x509.CRLDistributionPoints):
            name, txt = "Punti di distribuzione CRL", "\n".join(_gn(g) for dp in v for g in (dp.full_name or []))
        elif isinstance(v, x509.AuthorityInformationAccess):
            name, txt = "Accesso alle informazioni dell'autorita'", "\n".join(
                ("OCSP" if d.access_method.dotted_string.endswith(".1") else "Certificato emittente") + ": " + _gn(d.access_location).split(": ", 1)[-1] for d in v)
        elif isinstance(v, x509.CertificatePolicies):
            name, txt = "Politiche del certificato", "\n".join(p.policy_identifier.dotted_string + "".join(
                f"  ({q})" if isinstance(q, str) else "" for q in (p.policy_qualifiers or [])) for p in v)
        elif e.oid.dotted_string == "1.3.6.1.5.5.7.1.3":
            name, txt = "Dichiarazioni certificato qualificato (QC, eIDAS)", v.value.hex() if hasattr(v, "value") else str(v)
        else:
            txt = v.value.hex() if isinstance(v, x509.UnrecognizedExtension) else str(v)
    except Exception as ex:  # noqa: BLE001
        txt = f"<non leggibile: {ex}>"
    return {"nome": name, "oid": e.oid.dotted_string, "critica": e.critical, "valore": txt}


def _cert(c: x509.Certificate) -> dict:
    now = dt.datetime.now(dt.timezone.utc)
    a, b = c.not_valid_before_utc, c.not_valid_after_utc
    try:
        exts = [_ext(e) for e in c.extensions]
    except Exception as e:  # noqa: BLE001
        exts = [{"nome": "Estensioni", "oid": "", "critica": False, "valore": f"<non leggibili: {e}>"}]
    try:
        bc = c.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS).value.ca
    except Exception:
        bc = False
    usi = next((e["valore"] for e in exts if e["nome"] == "Uso della chiave"), "")
    eku = next((e["valore"] for e in exts if e["nome"] == "Uso esteso della chiave"), "")
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
            res["altri"].append({"tipo": "Elenco di revoca (CRL)", "emittente": _name(o.issuer), "emittente_nome": _cn(o.issuer),
                                 "aggiornato": _when(o.last_update_utc) if o.last_update_utc else "",
                                 "prossimo": _when(o.next_update_utc) if o.next_update_utc else "",
                                 "revocati": [{"seriale": format(r.serial_number, "X"), "data": _when(r.revocation_date_utc)} for r in list(o)[:5000]],
                                 "estensioni": [_ext(e) for e in o.extensions]})
        elif kind == "csr":
            res["altri"].append({"tipo": "Richiesta di certificato (CSR)", "soggetto": _name(o.subject), "soggetto_nome": _cn(o.subject),
                                 "chiave": _key(o.public_key()), "firma_valida": o.is_signature_valid,
                                 "estensioni": [_ext(e) for e in o.extensions]})
        elif kind == "pub":
            res["altri"].append({"tipo": "Chiave pubblica", "chiave": _key(o)})
    if not certs and not others:
        raise ValueError("Nessun certificato trovato nel file")
    return res


def export(pems: list, out: str, indice=None) -> dict:
    """Esporta i certificati gia' letti (solo parti pubbliche, in PEM): nessuna password serve qui."""
    certs = [x509.load_pem_x509_certificate(p.encode("ascii")) for p in pems]
    if not certs:
        raise ValueError("Il file non contiene certificati da esportare")
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
        raise ValueError(f"Formato di esportazione non previsto: .{ext}")
    with open(out, "wb") as f:
        f.write(blob)
    return {"ok": True, "path": out}


def summary_text(r: dict) -> str:
    lines = []
    for i, c in enumerate(r.get("certificati", [])):
        lines += [f"=== Certificato {i + 1}: {c['nome']} ===", f"Soggetto: {c['soggetto_dn']}", f"Emittente: {c['emittente_dn']}",
                  f"Valido dal {c['valido_dal']} al {c['valido_al']}" + (" (SCADUTO)" if c["scaduto"] else ""),
                  f"Numero di serie: {c['seriale']}", f"Chiave: {c['chiave']}", f"Algoritmo di firma: {c['algoritmo_firma']}",
                  f"SHA-1: {c['sha1']}", f"SHA-256: {c['sha256']}"]
        for e in c["estensioni"]:
            lines.append(f"{e['nome']}{' (critica)' if e['critica'] else ''}: {str(e['valore']).replace(chr(10), '; ')}")
        lines.append("")
    for ch in r.get("catene", []):
        lines.append("Catena: " + "  ->  ".join(a["nome"] for a in ch["anelli"]) + ("  [radice attendibile in Windows]" if ch["radice_attendibile"] else ""))
    return "\n".join(lines) + "\n"
