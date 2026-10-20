"""Documenti firmati digitalmente: CAdES (.p7m/.p7s), TSD, M7M, certificati (.p7c/.p7b) e firme PAdES nei PDF.

Verifica eseguita: integrita' (impronta del contenuto) e validita' crittografica della firma con la chiave
del certificato del firmatario, periodo di validita' del certificato. NON verificata: catena di fiducia
verso l'elenco AgID/eIDAS dei certificatori e revoca (CRL/OCSP) - richiedono accesso alla rete.
"""
import base64
import email
import hashlib
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from asn1crypto import cms, core, tsp, x509
from cryptography import x509 as cx509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from .paths import TEMP_DIR

HASHES = {"sha1": hashes.SHA1, "sha224": hashes.SHA224, "sha256": hashes.SHA256,
          "sha384": hashes.SHA384, "sha512": hashes.SHA512, "md5": hashes.MD5}


class TimeStampedData(core.Sequence):
    _fields = [
        ("version", core.Integer),
        ("data_uri", core.IA5String, {"optional": True}),
        ("meta_data", core.Any, {"optional": True}),
        ("content", core.OctetString, {"optional": True}),
        ("temporal_evidence", core.Any),
    ]


def _maybe_base64(data: bytes) -> bytes:
    head = data[:64].lstrip()
    if head.startswith(b"-----BEGIN"):
        body = b"".join(l for l in data.splitlines() if l and not l.startswith(b"-----"))
        return base64.b64decode(body)
    if head[:1] != b"\x30":
        try:
            dec = base64.b64decode(re.sub(rb"\s+", b"", data), validate=True)
            if dec[:1] == b"\x30":
                return dec
        except Exception:
            pass
    return data


def _fmt_time(t):
    if t is None:
        return None
    if isinstance(t, datetime):
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return t.astimezone().strftime("%d/%m/%Y %H:%M:%S")
    return str(t)


def _name_dict(name: x509.Name) -> dict:
    out = {}
    for rdn in name.chosen:
        for attr in rdn:
            key = attr["type"].native
            out[key] = attr["value"].native
    return out


def cert_info(cert: x509.Certificate) -> dict:
    subj = _name_dict(cert.subject)
    iss = _name_dict(cert.issuer)
    serial = subj.get("serial_number", "")
    cf = serial.split("-", 1)[1] if isinstance(serial, str) and "-" in serial else serial
    v = cert["tbs_certificate"]["validity"]
    nb, na = v["not_before"].native, v["not_after"].native
    now = datetime.now(timezone.utc)
    usages = []
    try:
        if cert.key_usage_value:
            usages = sorted(cert.key_usage_value.native)
    except Exception:
        pass
    return {
        "nome": subj.get("common_name") or " ".join(x for x in [subj.get("given_name"), subj.get("surname")] if x),
        "nome_proprio": subj.get("given_name"),
        "cognome": subj.get("surname"),
        "codice_fiscale": cf,
        "organizzazione": subj.get("organization_name"),
        "ruolo": subj.get("title"),
        "paese": subj.get("country_name"),
        "email": subj.get("email_address"),
        "emesso_da": iss.get("common_name") or iss.get("organization_name"),
        "ente_certificatore": iss.get("organization_name"),
        "valido_dal": _fmt_time(nb),
        "valido_al": _fmt_time(na),
        "scaduto": bool(na and now > na),
        "non_ancora_valido": bool(nb and now < nb),
        "numero_serie": format(cert.serial_number, "X"),
        "usi_chiave": usages,
    }


def _find_signer_cert(sid, certs):
    for c in certs:
        if sid.name == "issuer_and_serial_number":
            ias = sid.chosen
            if c.issuer == ias["issuer"] and c.serial_number == ias["serial_number"].native:
                return c
        elif sid.name == "subject_key_identifier":
            if c.key_identifier == sid.chosen.native:
                return c
    return certs[0] if len(certs) == 1 else None


def _verify_signature(cert, signed_bytes: bytes, signature: bytes, sig_algo: str, hash_name: str):
    pub = cx509.load_der_x509_certificate(cert.dump()).public_key()
    h = HASHES.get(hash_name, hashes.SHA256)()
    if isinstance(pub, rsa.RSAPublicKey):
        if sig_algo == "rsassa_pss":
            pub.verify(signature, signed_bytes, padding.PSS(mgf=padding.MGF1(h), salt_length=padding.PSS.AUTO), h)
        else:
            pub.verify(signature, signed_bytes, padding.PKCS1v15(), h)
    elif isinstance(pub, ec.EllipticCurvePublicKey):
        pub.verify(signature, signed_bytes, ec.ECDSA(h))
    else:
        pub.verify(signature, signed_bytes)


def _timestamp_from_token(token_der_or_ci) -> dict | None:
    try:
        ci = token_der_or_ci if isinstance(token_der_or_ci, cms.ContentInfo) else cms.ContentInfo.load(token_der_or_ci)
        tst = ci["content"]["encap_content_info"]["content"].parsed
        if not isinstance(tst, tsp.TSTInfo):
            tst = tsp.TSTInfo.load(ci["content"]["encap_content_info"]["content"].native)
        tsa = None
        certs = [c.chosen for c in ci["content"]["certificates"] or [] if c.name == "certificate"]
        if certs:
            tsa = cert_info(certs[0])["nome"]
        return {"data": _fmt_time(tst["gen_time"].native), "autorita": tsa}
    except Exception:
        return None


def analyze_signed_data(ci: cms.ContentInfo, detached: bytes | None = None) -> tuple[dict, bytes | None]:
    """Analizza una busta CMS SignedData. Ritorna (info, contenuto)."""
    sd = ci["content"]
    encap = sd["encap_content_info"]
    content = encap["content"].native if encap["content"].native is not None else None
    if isinstance(content, (bytearray, memoryview)):
        content = bytes(content)
    if content is None:
        content = detached
    certs = [c.chosen for c in (sd["certificates"] or []) if c.name == "certificate"]
    signers = []
    for si in sd["signer_infos"]:
        hash_name = si["digest_algorithm"]["algorithm"].native
        sig_algo = si["signature_algorithm"].signature_algo
        cert = _find_signer_cert(si["sid"], certs)
        res = {"certificato": cert_info(cert) if cert else None, "algoritmo": f"{hash_name.upper()} / {sig_algo}",
               "integrita": None, "firma_valida": None, "data_firma": None, "marca_temporale": None,
               "tipo": "CAdES-BES" if si["signed_attrs"] and any(a["type"].native in ("signing_certificate_v2", "signing_certificate") for a in si["signed_attrs"]) else "PKCS#7",
               "errori": []}
        signed_attrs = si["signed_attrs"]
        try:
            if signed_attrs:
                md = None
                for a in signed_attrs:
                    t = a["type"].native
                    if t == "message_digest":
                        md = a["values"][0].native
                    elif t == "signing_time":
                        res["data_firma"] = _fmt_time(a["values"][0].native)
                if content is not None and md is not None:
                    res["integrita"] = hashlib.new(hash_name, content).digest() == md
                signed_bytes = b"\x31" + signed_attrs.dump()[1:]
            else:
                signed_bytes = content or b""
                res["integrita"] = content is not None
            if cert:
                try:
                    _verify_signature(cert, signed_bytes, si["signature"].native, sig_algo, hash_name)
                    res["firma_valida"] = True
                except InvalidSignature:
                    res["firma_valida"] = False
        except Exception as e:  # noqa: BLE001
            res["errori"].append(str(e))
        for a in si["unsigned_attrs"] or []:
            if a["type"].native == "signature_time_stamp_token":
                res["marca_temporale"] = _timestamp_from_token(a["values"][0])
        signers.append(res)
    return {"tipo_busta": "SignedData", "firmatari": signers, "contenuto_presente": content is not None}, content


def _strip_sig_ext(name: str) -> str:
    n = name
    while True:
        low = n.lower()
        for ext in (".p7m", ".p7s", ".tsd", ".m7m", ".p7c"):
            if low.endswith(ext):
                n = n[: -len(ext)]
                break
        else:
            return n


def _looks_signed(data: bytes) -> cms.ContentInfo | None:
    if not data or data[:1] != b"\x30":
        return None
    try:
        ci = cms.ContentInfo.load(data)
        if ci["content_type"].native == "signed_data":
            ci["content"]["encap_content_info"]  # forza il parsing
            return ci
    except Exception:
        return None
    return None


def open_signed(path: str) -> dict:
    p = Path(path)
    raw = p.read_bytes()
    ext = p.suffix.lower()
    levels = []
    content = None
    certs_only = []
    note = None

    if ext == ".m7m":
        msg = email.message_from_bytes(raw)
        p7m, tsr = None, None
        for part in msg.walk():
            ctype = part.get_content_type()
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            if "pkcs7-mime" in ctype or "p7m" in (part.get_filename() or "").lower():
                p7m = payload
            elif "timestamp" in ctype or (part.get_filename() or "").lower().endswith((".tsr", ".tst")):
                tsr = payload
        raw = p7m or raw
        if tsr:
            ts = _timestamp_from_token(tsr) or _timestamp_from_token(tsp.TimeStampResp.load(tsr)["time_stamp_token"])
            levels.append({"tipo_busta": "Marca temporale M7M", "marca_temporale": ts, "firmatari": []})

    data = _maybe_base64(raw)

    # TimeStampedData (.tsd)
    try:
        ci0 = cms.ContentInfo.load(data)
        if ci0["content_type"].dotted == "1.2.840.113549.1.9.16.1.31":
            tsd = TimeStampedData.load(ci0["content"].contents)
            inner = tsd["content"].native
            ts = None
            try:
                ev = tsd["temporal_evidence"].parsed
                tokens = ev.native if isinstance(ev, core.Sequence) else None
                del tokens
            except Exception:
                pass
            try:
                ev_raw = tsd["temporal_evidence"].contents
                m = re.search(rb"\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x07\x02", ev_raw)
                if m:
                    start = ev_raw.rfind(b"\x30", 0, m.start())
                    ts = _timestamp_from_token(ev_raw[start:])
            except Exception:
                pass
            levels.append({"tipo_busta": "TimeStampedData (TSD)", "marca_temporale": ts, "firmatari": []})
            data = inner or b""
    except Exception:
        pass

    ci = _looks_signed(data)
    if ci is None:
        return {"ok": False, "errore": "Il file non contiene una busta di firma CMS/PKCS#7 riconoscibile."}

    detached = None
    if ext == ".p7s":
        sibling = p.with_suffix("")
        if sibling.is_file():
            detached = sibling.read_bytes()
            note = f"Firma separata verificata sul file: {sibling.name}"

    current = ci
    while current is not None:
        info, content = analyze_signed_data(current, detached)
        if not info["firmatari"]:
            certs_only = [cert_info(c.chosen) for c in (current["content"]["certificates"] or []) if c.name == "certificate"]
        levels.append(info)
        detached = None
        nxt = _looks_signed(content) if content else None
        current = nxt

    out_path = None
    if content:
        name = _strip_sig_ext(p.name)
        if name == p.name or "." not in name:
            name = name + _guess_ext(content)
        d = TEMP_DIR / "estratti" / uuid.uuid4().hex[:8]
        d.mkdir(parents=True, exist_ok=True)
        out_path = d / name
        out_path.write_bytes(content)
    return {"ok": True, "livelli": levels, "certificati": certs_only, "contenuto": str(out_path) if out_path else None,
            "nome_contenuto": out_path.name if out_path else None, "nota": note,
            "avviso": "Verificate integrita' e firma crittografica. Catena di fiducia (elenco AgID/eIDAS) e revoca non verificate: richiedono la rete."}


def _guess_ext(content: bytes) -> str:
    sig = content[:8]
    if sig.startswith(b"%PDF"):
        return ".pdf"
    if sig.startswith(b"PK"):
        return ".zip"
    if sig.startswith(b"<?xml") or sig.startswith(b"<"):
        return ".xml"
    if sig.startswith(b"\xd0\xcf\x11\xe0"):
        return ".doc"
    if sig.startswith(b"\x89PNG"):
        return ".png"
    if sig.startswith(b"\xff\xd8"):
        return ".jpg"
    return ".bin"


def pdf_signatures(path: str) -> dict:
    """Firme PAdES presenti in un PDF."""
    data = Path(path).read_bytes()
    sigs = []
    for m in re.finditer(rb"/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]", data):
        a, b, c, d = map(int, m.groups())
        # il blob /Contents e' il "buco" tra i due intervalli
        hole = data[a + b:c]
        hm = re.search(rb"<([0-9A-Fa-f\s]+)>", hole)
        if not hm:
            continue
        blob = bytes.fromhex(re.sub(rb"\s", b"", hm.group(1)).decode()).rstrip(b"\x00")
        signed = data[a:a + b] + data[c:c + d]
        try:
            ci = cms.ContentInfo.load(blob)
            info, _ = analyze_signed_data(ci, signed)
            info["copre_intero_file"] = (c + d) == len(data)
            sigs.append(info)
        except Exception as e:  # noqa: BLE001
            sigs.append({"errore": str(e)})
    return {"ok": True, "firme": sigs}
