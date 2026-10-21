"""Collaudo della firma digitale (mbvisual/firma.py, winsign.py) con un certificato di PROVA autofirmato.

    python tests/test_firma.py            # tutto in locale
    python tests/test_firma.py --tsa URL  # anche con marca temporale (es. http://timestamp.digicert.com)

Il certificato di prova (.pfx) nasce in una cartella temporanea e serve solo qui. La firma con il magazzino di Windows
si prova caricando il .pfx in un magazzino in memoria con chiave non salvata (stesso percorso NCrypt di smart card e
token, senza toccare i certificati del PC). La prova con una smart card vera la fa l'utente.
"""
import datetime as dt
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fitz  # noqa: E402
from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec, rsa  # noqa: E402
from cryptography.hazmat.primitives.serialization import pkcs12  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402

from mbvisual import firma, signed, winsign  # noqa: E402

PW = "prova-collaudo"


def make_pfx(folder: Path, kind="rsa") -> Path:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048) if kind == "rsa" else ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME, "IT"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "MB Visual - PROVA"),
                      x509.NameAttribute(NameOID.COMMON_NAME, f"Niccolò Prova ({kind.upper()})"),
                      x509.NameAttribute(NameOID.SERIAL_NUMBER, "TINIT-PRVNCC80A01H501X")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=30))
            .add_extension(x509.KeyUsage(True, True, False, False, False, False, False, False, False), critical=True)
            .sign(key, hashes.SHA256()))
    p = folder / f"prova_{kind}.pfx"
    p.write_bytes(pkcs12.serialize_key_and_certificates(b"prova", key, cert, None, serialization.BestAvailableEncryption(PW.encode())))
    return p


def make_pdf(path: Path, pages=2):
    doc = fitz.open()
    for i in range(pages):
        pg = doc.new_page(width=595, height=842)
        pg.insert_text((72, 100), f"Documento di prova MB Visual - pagina {i + 1}", fontsize=14)
    doc.save(path)


results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(("OK   " if cond else "ERR  ") + name + (" - " + str(extra) if extra else ""))


def main():
    tsa = sys.argv[sys.argv.index("--tsa") + 1] if "--tsa" in sys.argv else None
    tmp = Path(tempfile.mkdtemp(prefix="mbv-firma-"))
    firma.SETTINGS = tmp / "firma.json"  # le impostazioni vere dell'utente restano intatte
    pfx = make_pfx(tmp)
    pfx_ec = make_pfx(tmp, "ec")
    pdf = tmp / "documento.pdf"
    make_pdf(pdf)
    p12 = {"p12": str(pfx), "p12_password": PW}

    info = firma.p12_info(str(pfx), PW)
    check("lettura .pfx", info["certificato"]["qualificato"], info["certificato"]["nome"])
    try:
        firma.p12_info(str(pfx), "sbagliata")
        check("password .pfx errata rifiutata", False)
    except ValueError as e:
        check("password .pfx errata rifiutata", "errata" in str(e))

    # 1) PAdES invisibile
    out1 = tmp / "documento_firmato.pdf"
    r = firma.sign_pdf(str(pdf), str(out1), {**p12, "motivo": "Approvazione", "luogo": "Milano"})
    check("PAdES invisibile: firma valida e integra", r["firme_valide"] and r["numero_firme"] == 1)
    check("PAdES invisibile: PDF apribile", r["pdf_apribile"] and r["pagine"] == 2)
    check("PAdES: sottotipo ETSI.CAdES.detached", b"/ETSI.CAdES.detached" in out1.read_bytes())
    check("PAdES: copre l'intero file", r["verifica"]["firme"][0]["copre_intero_file"])

    # 2) seconda firma visibile (pagina 2, riquadro in basso a destra) sullo stesso file: la prima resta valida
    out2 = tmp / "documento_firmato_2.pdf"
    r = firma.sign_pdf(str(out1), str(out2), {**p12, "visibile": True, "pagina": 1, "riquadro": [330, 720, 560, 800]})
    firme = r["verifica"]["firme"]
    check("2 firme successive entrambe valide", r["firme_valide"] and r["numero_firme"] == 2, r["campo"])
    check("prima firma non copre piu' tutto il file (aggiornamento incrementale)", not firme[0]["copre_intero_file"] and firme[1]["copre_intero_file"])
    with fitz.open(out2) as d:
        widgets = [w for w in d[1].widgets() if w.field_type == fitz.PDF_WIDGET_TYPE_SIGNATURE]
        check("riquadro visibile sulla pagina 2 nella posizione scelta", widgets and abs(widgets[0].rect.x0 - 330) < 2 and abs(widgets[0].rect.y1 - 800) < 2,
              widgets and widgets[0].rect)
        d[1].get_pixmap(dpi=60).save(tmp / "anteprima_pagina2.png")

    # 3) terza firma con il magazzino di Windows (CNG) usando un magazzino in memoria, chiave RSA
    winsign.use_test_pfx(pfx.read_bytes(), PW)
    try:
        lst = firma.list_certs()["certificati"]
        check("magazzino Windows: certificato elencato", len(lst) == 1, lst and lst[0]["nome"])
        cid = lst[0]["id"]
        out3 = tmp / "documento_firmato_3.pdf"
        r = firma.sign_pdf(str(out2), str(out3), {"cert": cid, "visibile": True, "pagina": 0, "riquadro": [40, 700, 260, 780]})
        check("firma CNG (Windows) nel PDF: 3 firme valide", r["firme_valide"] and r["numero_firme"] == 3)
        out_w = tmp / "allegato_cng.txt.p7m"
        (tmp / "allegato_cng.txt").write_text("contenuto firmato con CNG")
        r = firma.sign_cades(str(tmp / "allegato_cng.txt"), str(out_w), {"cert": cid})
        check("CAdES con CNG (Windows) valida", r["firme_valide"])
    finally:
        winsign.use_test_pfx(None)
    winsign.use_test_pfx(pfx_ec.read_bytes(), PW)
    try:
        cid = firma.list_certs()["certificati"][0]["id"]
        r = firma.sign_cades(str(tmp / "allegato_cng.txt"), str(tmp / "allegato_ec.txt.p7m"), {"cert": cid})
        check("CAdES con CNG e chiave ECDSA valida", r["firme_valide"])
    finally:
        winsign.use_test_pfx(None)

    # 4) CAdES p7m di un file qualsiasi, p7s separata, firma parallela
    src = tmp / "relazione.docx"
    src.write_bytes(b"PK\x03\x04 finto docx " * 50)
    p7m = tmp / "relazione.docx.p7m"
    r = firma.sign_cades(str(src), str(p7m), p12)
    check("CAdES .p7m valida", r["firme_valide"] and r["verifica"]["livelli"][0]["firmatari"][0]["tipo"] == "CAdES-BES")
    ver = signed.open_signed(str(p7m))
    check("contenuto estratto identico all'originale", Path(ver["contenuto"]).read_bytes() == src.read_bytes())
    r = firma.sign_cades(str(src), str(tmp / "relazione.docx.p7s"), {**p12, "modo": "p7s"})
    check("CAdES .p7s separata valida", r["firme_valide"])
    check("verificatore: .p7s trovata accanto al file", signed.open_signed(str(tmp / "relazione.docx.p7s"))["livelli"][0]["firmatari"][0]["integrita"])
    p7m2 = tmp / "relazione_controfirmato.docx.p7m"
    r = firma.sign_cades(str(p7m), str(p7m2), {**p12, "modo": "parallela"})
    check("firma parallela: 2 firmatari validi nella stessa busta", r["firme_valide"] and r["numero_firme"] == 2)
    r = firma.sign_cades(str(p7m), str(tmp / "relazione.docx.p7m.p7m"), p12)
    lv = signed.open_signed(str(tmp / "relazione.docx.p7m.p7m"))["livelli"]
    check("busta annidata (p7m di p7m): 2 livelli validi", len(lv) == 2 and all(s["firma_valida"] for x in lv for s in x["firmatari"]))
    pdfp7m = tmp / "documento.pdf.p7m"
    r = firma.sign_cades(str(pdf), str(pdfp7m), p12)
    check("CAdES di un PDF valida", r["firme_valide"])

    # 5) marca temporale
    if tsa:
        r = firma.sign_pdf(str(pdf), str(tmp / "documento_marcato.pdf"), {**p12, "marca": True, "tsa_url": tsa})
        mt = r["verifica"]["firme"][0]["firmatari"][0].get("marca_temporale")
        check("PAdES con marca temporale", r["firme_valide"] and mt and mt.get("data"), mt)
        r = firma.sign_cades(str(src), str(tmp / "relazione_marcata.docx.p7m"), {**p12, "marca": True, "tsa_url": tsa})
        mt = r["verifica"]["livelli"][0]["firmatari"][0].get("marca_temporale")
        check("CAdES con marca temporale", r["firme_valide"] and mt and mt.get("data"), mt)

    # 6) alterazione: il verificatore deve accorgersene
    bad = bytearray(out1.read_bytes())
    i = bad.find(b"Documento di prova")
    if i < 0:
        i = 200
    bad[i + 3] ^= 0x01
    (tmp / "alterato.pdf").write_bytes(bad)
    f = signed.pdf_signatures(str(tmp / "alterato.pdf"))["firme"][0]["firmatari"][0]
    check("PDF alterato dopo la firma: rilevato", f["integrita"] is False)

    print(f"\n{sum(results)}/{len(results)} prove superate - file in {tmp}")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
