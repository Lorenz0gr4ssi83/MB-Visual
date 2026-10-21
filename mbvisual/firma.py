"""Firma digitale: PAdES nei PDF (visibile o invisibile, firme successive con aggiornamento incrementale) e CAdES
(.p7m con il file incluso, .p7s separata, firma parallela su un .p7m esistente), con marca temporale RFC 3161 opzionale.

Certificati: magazzino personale di Windows (smart card, CNS, token USB dei certificatori: la chiave resta sul
dispositivo e il PIN lo chiede Windows, vedi winsign.py) oppure file .p12/.pfx.
Librerie: pyHanko (MIT) per PDF e CMS, asn1crypto (MIT), cryptography (Apache-2.0/BSD).
Dopo ogni firma il risultato si verifica con il verificatore esistente (signed.py).
"""
import asyncio
import base64
import hashlib
import io
import json
import os
import re
from datetime import datetime
from pathlib import Path

from asn1crypto import algos, cms, x509

from . import signed

SETTINGS = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "MBVisual" / "firma.json"
DIGEST = "sha256"


# ------------------------------------------------------------------ impostazioni (TSA), password protetta con DPAPI
def _protect(text: str) -> str:
    import win32crypt
    return base64.b64encode(win32crypt.CryptProtectData(text.encode("utf-8"), "MB Visual TSA", None, None, None, 0)).decode()


def _unprotect(blob: str) -> str:
    import win32crypt
    return win32crypt.CryptUnprotectData(base64.b64decode(blob), None, None, None, 0)[1].decode("utf-8")


def _load() -> dict:
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except Exception:
        return {}


def settings() -> dict:
    s = _load()
    return {"ok": True, "tsa_url": s.get("tsa_url", ""), "tsa_utente": s.get("tsa_utente", ""),
            "tsa_password_salvata": bool(s.get("tsa_password")), "marca": bool(s.get("marca")),
            "motivo": s.get("motivo", ""), "luogo": s.get("luogo", ""), "ultimo": s.get("ultimo", "")}


def save_settings(b: dict) -> dict:
    s = _load()
    for k in ("tsa_url", "tsa_utente", "marca", "motivo", "luogo", "ultimo"):
        if k in b:
            s[k] = b[k]
    if b.get("tsa_password") is not None:  # "" = cancella
        s["tsa_password"] = _protect(b["tsa_password"]) if b["tsa_password"] else ""
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(s, indent=1), encoding="utf-8")
    return settings()


def _timestamper(opts: dict):
    if not opts.get("marca"):
        return None
    from pyhanko.sign.timestamps import HTTPTimeStamper
    s = _load()
    url = (opts.get("tsa_url") or s.get("tsa_url") or "").strip()
    if not url:
        raise ValueError("Marca temporale richiesta ma manca l'indirizzo del servizio (TSA): impostalo nella finestra di firma.")
    user = opts.get("tsa_utente", s.get("tsa_utente", "")) or ""
    pw = opts.get("tsa_password")
    if pw is None and s.get("tsa_password"):
        pw = _unprotect(s["tsa_password"])
    auth = (user, pw or "") if user else None
    return HTTPTimeStamper(url, https=url.lower().startswith("https"), timeout=30, auth=auth)


# ------------------------------------------------------------------ certificati
def _cert_entry(cert: x509.Certificate, **extra) -> dict:
    info = signed.cert_info(cert)
    usi = set(info.get("usi_chiave") or [])
    return {**info, "qualificato": "non_repudiation" in usi, "solo_autenticazione": bool(usi) and not usi & {"non_repudiation", "digital_signature"},
            "algoritmo_chiave": cert.public_key.algorithm.upper(), **extra}


def _dispositivo(provider: str) -> str:
    p = provider.lower()
    if "smart card" in p or "smartcard" in p or "minidriver" in p:
        return "Smart card / token"
    if "software" in p or "enhanced" in p or "strong" in p or "rsa and aes" in p:
        return "Certificato installato in Windows"
    if "platform" in p:
        return "Chip TPM del PC"
    return provider or "Dispositivo"


def list_certs() -> dict:
    from . import winsign
    out = []
    for c in winsign.list_certificates():
        try:
            cert = x509.Certificate.load(c["der"])
        except Exception:
            continue
        e = _cert_entry(cert, id=c["id"], provider=c["provider"], dispositivo=_dispositivo(c["provider"]))
        if e["solo_autenticazione"] and not e["qualificato"]:
            continue  # certificati solo per accesso/cifratura: non servono per firmare
        out.append(e)
    # prima i certificati di firma qualificata validi, poi gli altri
    out.sort(key=lambda e: (e["scaduto"] or e["non_ancora_valido"], not e["qualificato"], e.get("nome") or ""))
    return {"ok": True, "certificati": out}


def p12_info(path: str, password: str) -> dict:
    s = _p12_signer(path, password)
    return {"ok": True, "certificato": _cert_entry(s.signing_cert, dispositivo="File " + Path(path).suffix.lower())}


def _p12_signer(path: str, password: str):
    from pyhanko.sign import signers
    from cryptography.hazmat.primitives.serialization import pkcs12
    data = Path(path).read_bytes()
    try:
        pkcs12.load_key_and_certificates(data, password.encode("utf-8") if password else None)
    except ValueError:
        raise ValueError("Password del file .p12/.pfx errata o file non valido.") from None
    s = signers.SimpleSigner.load_pkcs12_data(data, other_certs=[], passphrase=password.encode("utf-8") if password else None)
    if s is None:
        raise ValueError("Il file .p12/.pfx non contiene una chiave privata con certificato.")
    return s


def _win_signer(cert_id: str):
    from pyhanko.sign.signers.pdf_cms import Signer
    from pyhanko_certvalidator.registry import SimpleCertificateStore
    from . import winsign

    der = next((c["der"] for c in winsign.list_certificates() if c["id"] == cert_id.upper()), None)
    if der is None:
        raise ValueError("Certificato non trovato: inserisci la smart card o il token e riprova.")
    cert = x509.Certificate.load(der)
    chain = []
    for d in winsign.chain(cert_id):
        try:
            chain.append(x509.Certificate.load(d))
        except Exception:
            pass
    key_algo = cert.public_key.algorithm
    if key_algo not in ("rsa", "ec"):
        raise ValueError(f"Tipo di chiave non supportato: {key_algo}")

    class WinSigner(Signer):
        async def async_sign_raw(self, data: bytes, digest_algorithm: str, dry_run=False) -> bytes:
            if dry_run:  # solo per stimare lo spazio della firma
                return bytes(cert.public_key.bit_size // 8 if key_algo == "rsa" else 2 * ((cert.public_key.bit_size + 7) // 8) + 9)
            digest = hashlib.new(digest_algorithm, data).digest()
            hwnd = None
            try:
                import ctypes
                hwnd = ctypes.windll.user32.GetForegroundWindow() or None  # finestra del PIN sopra l'app
            except Exception:
                pass
            sig = winsign.sign_digest(cert_id, digest, digest_algorithm, key_algo, hwnd)
            if key_algo == "ec":
                sig = algos.DSASignature.from_p1363(sig).dump()
            return sig

    return WinSigner(signing_cert=cert, cert_registry=SimpleCertificateStore.from_certs([cert, *chain]), embed_roots=False)


def _signer(opts: dict):
    if opts.get("p12"):
        return _p12_signer(opts["p12"], opts.get("p12_password") or "")
    if not opts.get("cert"):
        raise ValueError("Scegli il certificato con cui firmare.")
    return _win_signer(opts["cert"])


# ------------------------------------------------------------------ anteprima pagina per posizionare il riquadro
def page_preview(path: str, page: int, width: int = 520) -> dict:
    import fitz
    with fitz.open(path) as doc:
        n = doc.page_count
        page = max(0, min(n - 1, page))
        pg = doc[page]
        zoom = width / pg.rect.width
        pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        return {"ok": True, "pagine": n, "pagina": page, "w": pg.rect.width, "h": pg.rect.height,
                "png": base64.b64encode(pix.tobytes("png")).decode()}


def _pdf_box(path: str, page: int, box) -> tuple:
    """Riquadro dalla pagina come si vede (punti, origine in alto a sinistra) alle coordinate PDF della pagina."""
    import fitz
    with fitz.open(path) as doc:
        pg = doc[page]
        m = ~(pg.transformation_matrix * pg.rotation_matrix)
        r = (fitz.Rect(*box) * m).normalize()
        return (round(r.x0), round(r.y0), round(r.x1), round(r.y1))


def _field_name(reader) -> str:
    from pyhanko.sign.fields import enumerate_sig_fields
    used = {name for name, _v, _r in enumerate_sig_fields(reader)}
    n = 1
    while f"Firma{n}" in used:
        n += 1
    return f"Firma{n}"


# ------------------------------------------------------------------ firma PAdES
def sign_pdf(src: str, out: str, opts: dict, update=None) -> dict:
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers
    from pyhanko.sign.fields import SigSeedSubFilter
    from pyhanko.stamp import TextStampStyle

    upd = update or (lambda *a, **k: None)
    upd(0.1, "Preparazione della firma")
    signer = _signer(opts)
    ts = _timestamper(opts)
    data = Path(src).read_bytes()
    w = IncrementalPdfFileWriter(io.BytesIO(data), strict=False)
    if w.prev.encrypted:
        raise ValueError("Il PDF e' protetto da password: toglila prima di firmare.")
    name = _field_name(w.prev)
    meta = signers.PdfSignatureMetadata(field_name=name, md_algorithm=DIGEST, subfilter=SigSeedSubFilter.PADES,
                                        reason=opts.get("motivo") or None, location=opts.get("luogo") or None,
                                        name=signed.cert_info(signer.signing_cert).get("nome") or None)
    spec = None
    style = None
    if opts.get("visibile"):
        page = int(opts.get("pagina") or 0)
        box = _pdf_box(src, page, opts.get("riquadro") or (350, 700, 560, 780))
        spec = fields.SigFieldSpec(sig_field_name=name, on_page=page, box=box)
        lines = ["Firmato digitalmente da", "%(signer)s", "Data: %(ts)s"]
        if opts.get("motivo"):
            lines.append("Motivo: " + opts["motivo"].replace("%", "%%"))
        if opts.get("luogo"):
            lines.append("Luogo: " + opts["luogo"].replace("%", "%%"))
        style = TextStampStyle(stamp_text="\n".join(lines), timestamp_format="%d/%m/%Y %H:%M:%S", border_width=1)
    else:
        spec = fields.SigFieldSpec(sig_field_name=name)  # riquadro vuoto = firma invisibile
    upd(0.3, "Firma in corso (inserisci il PIN se Windows lo chiede)")
    pdf_signer = signers.PdfSigner(meta, signer=signer, timestamper=ts, stamp_style=style, new_field_spec=spec)
    buf = io.BytesIO()
    try:
        pdf_signer.sign_pdf(w, output=buf)
    except Exception as e:  # noqa: BLE001
        raise ValueError(_explain(e)) from e
    Path(out).write_bytes(buf.getvalue())
    upd(0.9, "Verifica della firma")
    ver = signed.pdf_signatures(out)
    _remember(opts)
    return {"ok": True, "out": out, "campo": name, "verifica": ver, **_check(ver.get("firme") or [], pdf=out)}


# ------------------------------------------------------------------ firma CAdES (.p7m / .p7s / parallela)
def sign_cades(src: str, out: str, opts: dict, update=None) -> dict:
    upd = update or (lambda *a, **k: None)
    upd(0.1, "Preparazione della firma")
    signer = _signer(opts)
    ts = _timestamper(opts)
    data = Path(src).read_bytes()
    mode = opts.get("modo") or "p7m"  # p7m | p7s | parallela
    upd(0.3, "Firma in corso (inserisci il PIN se Windows lo chiede)")
    try:
        if mode == "parallela":
            orig = signed._looks_signed(signed._maybe_base64(data))
            if orig is None:
                raise ValueError("Il file non e' una busta .p7m: la firma parallela si aggiunge solo a un documento gia' firmato.")
            content = orig["content"]["encap_content_info"]["content"].native
            if content is None:
                raise ValueError("La busta non contiene il documento (firma separata): impossibile aggiungere una firma parallela.")
            new = asyncio.run(signer.async_sign_general_data(io.BytesIO(content), DIGEST, detached=True, use_cades=True, timestamper=ts))
            res = _add_parallel(orig, new)
        else:
            res = asyncio.run(signer.async_sign_general_data(io.BytesIO(data), DIGEST, detached=(mode == "p7s"), use_cades=True, timestamper=ts))
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001
        raise ValueError(_explain(e)) from e
    Path(out).write_bytes(res.dump(force=True))
    upd(0.9, "Verifica della firma")
    if mode == "p7s":
        info, _ = signed.analyze_signed_data(cms.ContentInfo.load(Path(out).read_bytes()), data)
        ver = {"ok": True, "livelli": [info]}
    else:
        ver = signed.open_signed(out)
    _remember(opts)
    signers_ = [s for lv in ver.get("livelli") or [] for s in lv.get("firmatari") or []]
    return {"ok": True, "out": out, "verifica": ver, **_check([{"firmatari": signers_}])}


def _add_parallel(orig: cms.ContentInfo, new: cms.ContentInfo) -> cms.ContentInfo:
    """Aggiunge il firmatario di `new` (firma separata sullo stesso contenuto) alla busta `orig`."""
    sd, nsd = orig["content"], new["content"]
    algs = list(sd["digest_algorithms"])
    for a in nsd["digest_algorithms"]:
        if all(a.dump() != b.dump() for b in algs):
            algs.append(a)
    certs = list(sd["certificates"] or [])
    have = {c.dump() for c in certs}
    certs += [c for c in nsd["certificates"] or [] if c.dump() not in have]
    out = cms.SignedData({
        "version": max(sd["version"].native, nsd["version"].native, key=lambda v: int(v[1:])),
        "digest_algorithms": algs,
        "encap_content_info": sd["encap_content_info"],
        "certificates": certs,
        "signer_infos": list(sd["signer_infos"]) + list(nsd["signer_infos"]),
    })
    if sd["crls"]:
        out["crls"] = sd["crls"]
    return cms.ContentInfo({"content_type": "signed_data", "content": out})


# ------------------------------------------------------------------ utilita'
def _check(firme: list, pdf: str | None = None) -> dict:
    all_s = [s for f in firme for s in (f.get("firmatari") or [])]
    ok = bool(all_s) and all(s.get("firma_valida") and s.get("integrita") is not False for s in all_s)
    res = {"firme_valide": ok, "numero_firme": len(all_s)}
    if pdf:
        import fitz
        try:
            with fitz.open(pdf) as d:
                res["pagine"] = d.page_count
                d[0].get_text()  # il PDF firmato si apre e si legge
            res["pdf_apribile"] = True
        except Exception as e:  # noqa: BLE001
            res["pdf_apribile"] = False
            res["errore_apertura"] = str(e)
    return res


def _remember(opts: dict):
    try:
        s = _load()
        if opts.get("cert"):
            s["ultimo"] = opts["cert"]
        for k in ("motivo", "luogo", "marca"):
            if k in opts:
                s[k] = opts[k]
        SETTINGS.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS.write_text(json.dumps(s, indent=1), encoding="utf-8")
    except Exception:
        pass


def _explain(e: Exception) -> str:
    msg = str(e) or e.__class__.__name__
    low = msg.lower()
    if "timestamp" in low or "tsa" in low or "clientconnector" in low or "timeout" in low:
        return "Marca temporale non ottenuta: controlla indirizzo, utente e password del servizio TSA e la connessione. (" + msg + ")"
    if "docmdp" in low or "certif" in low and "modif" in low:
        return "Il PDF e' certificato dall'autore e non accetta altre firme. (" + msg + ")"
    return msg


def default_out(src: str, kind: str) -> str:
    p = Path(src)
    if kind == "pades":
        stem = re.sub(r"(_firmato)+$", "", p.stem)
        return str(p.with_name(stem + "_firmato.pdf"))
    if kind == "p7s":
        return str(p) + ".p7s"
    if kind == "parallela":
        return str(p.with_name(p.stem + "_controfirmato" + p.suffix)) if p.suffix.lower() == ".p7m" else str(p) + ".p7m"
    return str(p) + ".p7m"


def run(op: str, b: dict) -> dict:
    """Punto unico per il server (api/firma?op=...)."""
    if op == "certificati":
        return list_certs()
    if op == "impostazioni":
        return save_settings(b) if b else settings()
    if op == "p12":
        return p12_info(b["p12"], b.get("p12_password") or "")
    if op == "anteprima":
        return page_preview(b["path"], int(b.get("pagina") or 0))
    if op == "uscita":
        return {"ok": True, "out": default_out(b["path"], b.get("tipo") or "p7m"), "oggi": datetime.now().strftime("%d/%m/%Y")}
    raise ValueError("operazione di firma sconosciuta")
