"""Crea i file di prova dei formati aggiunti in tests/samples/fx (tutti generati qui, nessun dato reale).

- DICOM: serie TC sintetica di 24 sezioni (fantoccio con "ossa" e "polmoni") + copia di due file d'esempio di pydicom
  (CT_small.dcm, emri_small.dcm: licenza MIT di pydicom, vedi pydicom/data/test_files/README.txt)
- calendario .ics, contatti .vcf, certificati (catena radice -> intermedio -> finale, .p12 con password "prova")
- plotter .plt (HP-GL/2), HDF5 .h5, NetCDF 3 .nc, Parquet, Feather/Arrow
Uso: python tools/make_fx_samples.py
"""
import datetime as dt
import shutil
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "samples" / "fx"


def dicom():
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage
    d = OUT / "dicom_serie_tc"
    d.mkdir(parents=True, exist_ok=True)
    study, series, frame = generate_uid(), generate_uid(), generate_uid()
    n, size = 24, 128
    yy, xx = np.mgrid[0:size, 0:size] * (192 / size)  # fantoccio disegnato su 192 px, poi ridotto
    for i in range(n):
        z = i / (n - 1)
        img = np.full((size, size), -1000, np.int16)                       # aria
        body = ((xx - 96) / 80) ** 2 + ((yy - 96) / 62) ** 2 < 1
        img[body] = 40                                                       # tessuti molli
        for cx in (64, 128):                                                 # polmoni
            img[((xx - cx) / 24) ** 2 + ((yy - 90) / (34 - 8 * abs(z - .5))) ** 2 < 1] = -820
        img[((xx - 96) / 10) ** 2 + ((yy - 140) / 10) ** 2 < 1] = 900        # vertebra
        img[((xx - 96) / (14 + 8 * z)) ** 2 + ((yy - 80) / 12) ** 2 < 1] = 180  # cuore/aorta (contrasto)
        img = (img + np.random.default_rng(i).normal(0, 12, img.shape)).astype(np.int16)
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = generate_uid()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = FileDataset(str(d / f"IM{i + 1:04d}"), {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, meta.MediaStorageSOPInstanceUID
        ds.PatientName, ds.PatientID, ds.PatientBirthDate, ds.PatientSex = "PROVA^FANTOCCIO", "MBV0001", "19800101", "O"
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, frame
        ds.StudyDate, ds.StudyDescription, ds.SeriesDescription = "20261022", "TC torace (sintetica)", "Assiale 5 mm"
        ds.Modality, ds.Manufacturer, ds.InstitutionName, ds.BodyPartExamined = "CT", "MB Desk", "Esempio generato", "CHEST"
        ds.SeriesNumber, ds.InstanceNumber = 2, i + 1
        ds.ImagePositionPatient = [-64 * 0.8, -64 * 0.8, -60 + i * 5.0]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.SliceThickness, ds.PixelSpacing, ds.SliceLocation = 5.0, [1.2, 1.2], -60 + i * 5.0
        ds.Rows, ds.Columns, ds.SamplesPerPixel, ds.PhotometricInterpretation = size, size, 1, "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 12, 11, 0
        ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1024, 1, "HU"
        ds.WindowCenter, ds.WindowWidth, ds.WindowCenterWidthExplanation = [40, -600], [400, 1500], ["TESSUTI", "POLMONE"]
        ds.PixelData = (img.astype(np.int32) + 1024).clip(0, 4095).astype("<u2").tobytes()
        # nella cartella: i primi file con .dcm, gli altri senza estensione come nei CD
        ds.save_as(str(d / (f"IM{i + 1:04d}.dcm" if i < 12 else f"IM{i + 1:04d}")), enforce_file_format=True)
    import pydicom.data as pd
    for name in ("CT_small.dcm", "emri_small.dcm"):
        p = pd.get_testdata_file(name)
        if p:
            shutil.copy(p, OUT / name)


ICS = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//MB Desk//Esempio//IT
X-WR-CALNAME:Cantiere via Roma
BEGIN:VTIMEZONE
TZID:Europe/Rome
BEGIN:STANDARD
DTSTART:19701025T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:riunione-1@mbvisual
DTSTAMP:20261001T080000Z
DTSTART;TZID=Europe/Rome:20261005T090000
DTEND;TZID=Europe/Rome:20261005T103000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8
EXDATE;TZID=Europe/Rome:20261019T090000
SUMMARY:Riunione di coordinamento sicurezza
LOCATION:Baracca di cantiere\\, via Roma 12
DESCRIPTION:Ordine del giorno:\\n1. Avanzamento lavori\\n2. Verbale CSE
ORGANIZER;CN=Lorenzo Rossi:mailto:l.rossi@example.com
ATTENDEE;CN=Impresa Edile Bianchi;PARTSTAT=ACCEPTED:mailto:info@example.com
ATTENDEE;CN=Studio Verdi;PARTSTAT=TENTATIVE:mailto:studio@example.org
BEGIN:VALARM
TRIGGER:-PT15M
ACTION:DISPLAY
DESCRIPTION:Promemoria
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:getto@mbvisual
DTSTAMP:20261001T080000Z
DTSTART:20261014T060000Z
DTEND:20261014T140000Z
SUMMARY:Getto solaio piano primo
CATEGORIES:Lavori,Calcestruzzo
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:collaudo@mbvisual
DTSTAMP:20261001T080000Z
DTSTART;VALUE=DATE:20261027
DTEND;VALUE=DATE:20261029
SUMMARY:Collaudo statico (due giorni)
LOCATION:Cantiere
END:VEVENT
BEGIN:VEVENT
UID:sal@mbvisual
DTSTAMP:20261001T080000Z
DTSTART;VALUE=DATE:20261031
SUMMARY:Consegna SAL n. 3 con una descrizione molto lunga che deve andare a capo 
 e continua sulla riga successiva
RRULE:FREQ=MONTHLY;INTERVAL=1;COUNT=4
END:VEVENT
BEGIN:VTODO
UID:todo1@mbvisual
DTSTAMP:20261001T080000Z
DUE;VALUE=DATE:20261020
SUMMARY:Inviare POS aggiornato
PRIORITY:1
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR
"""

VCF = """BEGIN:VCARD
VERSION:3.0
N:Rossi;Lorenzo;;Ing.;
FN:Ing. Lorenzo Rossi
ORG:Studio Tecnico Rossi;Strutture
TITLE:Direttore dei lavori
TEL;TYPE=WORK,VOICE:+39 02 1234567
TEL;TYPE=CELL:+39 333 1234567
EMAIL;TYPE=INTERNET,WORK:l.rossi@example.com
ADR;TYPE=WORK:;;Via Roma 12;Milano;MI;20100;Italia
URL:https://example.com
BDAY:1983-04-12
NOTE:Reperibile dalle 8 alle 18.\\nPreferisce le email.
CATEGORIES:Clienti,Cantiere
PHOTO;ENCODING=b;TYPE=PNG:{foto}
END:VCARD
BEGIN:VCARD
VERSION:4.0
FN:Giulia Bianchi
N:Bianchi;Giulia;;;
ORG:Impresa Edile Bianchi S.r.l.
TEL;TYPE="cell,voice";VALUE=uri:tel:+39-347-7654321
EMAIL;TYPE=work:g.bianchi@example.org
ADR;TYPE=work;LABEL="Via Garibaldi 5\\n10100 Torino":;;Via Garibaldi 5;Torino;TO;10100;Italia
END:VCARD
BEGIN:VCARD
VERSION:2.1
N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Verdi;Andr=C3=A9;;;
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Andr=C3=A9 Verdi
TEL;HOME:0039 011 555666
EMAIL;PREF;INTERNET:andre@example.net
END:VCARD
"""


def pim():
    import base64
    import io
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (96, 96), (44, 103, 151))
    ImageDraw.Draw(im).ellipse((24, 14, 72, 62), fill=(240, 210, 180))
    ImageDraw.Draw(im).rectangle((14, 66, 82, 96), fill=(230, 230, 230))
    b = io.BytesIO()
    im.save(b, "PNG")
    foto = base64.b64encode(b.getvalue()).decode()
    lines = [foto[i:i + 74] for i in range(0, len(foto), 74)]
    (OUT / "cantiere.ics").write_bytes(ICS.replace("\n", "\r\n").encode("utf-8"))
    (OUT / "rubrica.vcf").write_bytes(VCF.replace("{foto}", "\n ".join(lines)).replace("\n", "\r\n").encode("utf-8"))


def certs():
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, rsa
    from cryptography.hazmat.primitives.serialization import pkcs7, pkcs12
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)

    def name(cn, o="MB Desk Esempi"):
        return x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME, "IT"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, o),
                          x509.NameAttribute(NameOID.COMMON_NAME, cn)])

    def make(subject, issuer, key, sign_key, ca, years, eku=None, san=None, path_len=None):
        b = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer).public_key(key.public_key())
             .serial_number(x509.random_serial_number()).not_valid_before(now).not_valid_after(now + dt.timedelta(days=365 * years))
             .add_extension(x509.BasicConstraints(ca=ca, path_length=path_len), critical=True)
             .add_extension(x509.KeyUsage(digital_signature=not ca, content_commitment=not ca, key_encipherment=not ca, data_encipherment=False,
                                          key_agreement=False, key_cert_sign=ca, crl_sign=ca, encipher_only=False, decipher_only=False), critical=True)
             .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False))
        if eku:
            b = b.add_extension(x509.ExtendedKeyUsage(eku), critical=False)
        if san:
            b = b.add_extension(x509.SubjectAlternativeName(san), critical=False)
        return b.sign(sign_key, hashes.SHA256())

    rk = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ik = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    lk = ec.generate_private_key(ec.SECP256R1())
    root = make(name("MB Desk Radice di Prova"), name("MB Desk Radice di Prova"), rk, rk, True, 20, path_len=1)
    inter = make(name("MB Desk CA Intermedia di Prova"), root.subject, ik, rk, True, 10, path_len=0)
    leaf = make(name("prova.example.com", "Studio Tecnico di Prova"), inter.subject, lk, ik, False, 1,
                eku=[ExtendedKeyUsageOID.SERVER_AUTH, ExtendedKeyUsageOID.CLIENT_AUTH],
                san=[x509.DNSName("prova.example.com"), x509.DNSName("www.prova.example.com"), x509.RFC822Name("info@example.com")])
    pem = serialization.Encoding.PEM
    (OUT / "certificato.crt").write_bytes(leaf.public_bytes(pem))
    (OUT / "certificato.cer").write_bytes(leaf.public_bytes(serialization.Encoding.DER))
    (OUT / "catena.pem").write_bytes(leaf.public_bytes(pem) + inter.public_bytes(pem) + root.public_bytes(pem))
    (OUT / "radice.der").write_bytes(root.public_bytes(serialization.Encoding.DER))
    (OUT / "catena.p7b").write_bytes(pkcs7.serialize_certificates([leaf, inter, root], serialization.Encoding.DER))
    (OUT / "identita_password_prova.p12").write_bytes(pkcs12.serialize_key_and_certificates(
        b"prova", lk, leaf, [inter, root], serialization.BestAvailableEncryption(b"prova")))
    csr = (x509.CertificateSigningRequestBuilder().subject_name(name("richiesta.example.com"))
           .add_extension(x509.SubjectAlternativeName([x509.DNSName("richiesta.example.com")]), critical=False).sign(lk, hashes.SHA256()))
    (OUT / "richiesta.csr").write_bytes(csr.public_bytes(pem))
    crl = (x509.CertificateRevocationListBuilder().issuer_name(inter.subject).last_update(now).next_update(now + dt.timedelta(days=7))
           .add_revoked_certificate(x509.RevokedCertificateBuilder().serial_number(12345).revocation_date(now).build()).sign(ik, hashes.SHA256()))
    (OUT / "revoche.crl").write_bytes(crl.public_bytes(serialization.Encoding.DER))


def plotter():
    # HP-GL/2 come quello prodotto dai driver dei plotter: inizializzazione, penne, spessori, linee, archi, testo, poligoni
    s = ["\x1b%-12345X@PJL ENTER LANGUAGE=HPGL2\r\n", "\x1bE\x1b%0B", "IN;", "PS40000,28000;", "NP8;",
         "PC1,0,0,0;PC2,200,0,0;PC3,0,120,200;PC4,0,160,0;", "PW0.35,1;PW0.18,2;PW0.5,3;PW0.25,4;",
         "SP1;PU0,0;PD16000,0,16000,11000,0,11000,0,0;",                         # cornice
         "PU15200,0;PD15200,1800,16000,1800;PU11000,0;PD11000,1800,15200,1800;",  # cartiglio
         "SP2;PU2000,2000;PD9000,2000,9000,8000,2000,8000,2000,2000;",            # pianta
         "PU2000,5000;PD9000,5000;PU5500,2000;PD5500,8000;",
         "SP3;PU12500,6500;CI1800;PU12500,6500;PD12500,6500;",                    # cerchio
         "PU10700,6500;PD14300,6500;PU12500,4700;PD12500,8300;",
         "SP4;PU2000,2000;AA2000,2000,90;",                                       # arco
         "PU9500,3000;PM0;PD10800,3000,10800,4300,9500,4300;PM2;FP;EP;",          # rettangolo pieno
         "SP1;SI0.25,0.35;PU11200,700;LBPIANTA PIANO TERRA - SCALA 1:100\x03",
         "SI0.18,0.25;PU11200,1200;LBMB Desk - esempio HPGL\x03",
         "DI0,1;PU1500,2500;LBQUOTA 7000\x03DI1,0;",
         "SP2;LT2,4;PU2000,8600;PD9000,8600;LT;",
         "PU0,0;SP0;", "\x1bE\x1b%-12345X"]
    (OUT / "pianta_plotter.plt").write_bytes("".join(s).encode("latin-1"))
    # HP-GL/2 compresso (PE, come i driver AutoCAD/HP DesignJet): spirale e stella in coordinate relative, base 64
    def enc(v):
        z = (v << 1) if v >= 0 else (((-v) << 1) | 1)
        out = bytearray()
        while z >= 64:
            out.append(63 + (z % 64))
            z //= 64
        out.append(191 + z)
        return bytes(out)
    import math
    pe = bytearray(b"IN;PW0.3,1;SP1;PE<=" + enc(8000) + enc(6000))
    px, py = 8000, 6000
    for k in range(1, 400):
        a, r = k * 0.12, 20 + k * 12
        nx, ny = int(8000 + r * math.cos(a)), int(6000 + r * math.sin(a))
        pe += enc(nx - px) + enc(ny - py)
        px, py = nx, ny
    pe += b";SP2;PE<=" + enc(2000) + enc(2000)
    star = [(2000 + int(1500 * math.cos(math.pi / 2 + k * 4 * math.pi / 5)), 2000 + int(1500 * math.sin(math.pi / 2 + k * 4 * math.pi / 5))) for k in range(6)]
    px, py = 2000, 2000
    pe += b"<" + enc(star[0][0] - px) + enc(star[0][1] - py)
    px, py = star[0]
    for x, y in star[1:]:
        pe += enc(x - px) + enc(y - py)
        px, py = x, y
    pe += b";SP0;"
    (OUT / "spirale_pe.hgl").write_bytes(bytes(pe))
    # HP-GL classico (7475A), coordinate assolute e relative
    (OUT / "schema.hpgl").write_bytes(b"IN;SP1;PA1000,1000;PD;PR3000,0,0,2000,-3000,0,0,-2000;PU;PA2500,2000;SP2;CI800;"
                                      b"SP3;PA1000,3500;LBSchema elettrico\x03;SP0;")


def scidata():
    import h5py
    import pyarrow as pa
    import pyarrow.feather as feather
    import pyarrow.parquet as pq
    rng = np.random.default_rng(1)
    t = np.arange(0, 600, 0.5)
    with h5py.File(OUT / "misure.h5", "w") as f:
        f.attrs["titolo"] = "Monitoraggio strutturale (sintetico)"
        f.attrs["creato"] = "2026-10-22"
        g = f.create_group("sensori")
        d = g.create_dataset("accelerazione", data=np.sin(t / 10)[:, None] * [1, 0.6, 0.3] + rng.normal(0, .05, (t.size, 3)), compression="gzip")
        d.attrs["unita"] = "m/s2"
        d.attrs["colonne"] = ["x", "y", "z"]
        g.create_dataset("tempo", data=t).attrs["unita"] = "s"
        f.create_dataset("mappa_temperatura", data=20 + 5 * np.outer(np.sin(np.linspace(0, 3, 64)), np.cos(np.linspace(0, 3, 48))))
        tab = np.zeros(5, dtype=[("id", "i4"), ("nome", "S20"), ("carico_kN", "f8")])
        tab["id"] = range(1, 6)
        tab["nome"] = [b"Pilastro P1", b"Pilastro P2", b"Trave T1", b"Trave T2", b"Plinto"]
        tab["carico_kN"] = [512.5, 498.0, 120.25, 133.0, 1020.0]
        f.create_dataset("elementi", data=tab)
        f.create_dataset("volume", data=rng.random((8, 16, 16)).astype("f4"))
    _netcdf3(OUT / "meteo.nc")
    n = 1000
    table = pa.table({
        "data": pa.array([dt.date(2026, 1, 1) + dt.timedelta(days=i % 365) for i in range(n)]),
        "commessa": pa.array([f"C-{100 + i % 17}" for i in range(n)]),
        "ore": pa.array(np.round(rng.uniform(0.5, 9, n), 2)),
        "costo_eur": pa.array(np.round(rng.uniform(30, 900, n), 2)),
        "fatturato": pa.array(rng.random(n) > .3),
    })
    pq.write_table(table, OUT / "ore_commesse.parquet", row_group_size=250)
    feather.write_feather(table, OUT / "ore_commesse.feather")
    with pa.OSFile(str(OUT / "ore_commesse.arrow"), "wb") as sink, pa.ipc.new_file(sink, table.schema) as w:
        w.write_table(table)


def _netcdf3(path):
    """NetCDF 3 classico scritto a mano (formato pubblico Unidata): dimensioni, attributi, variabili, una illimitata."""
    import struct
    lat, lon, tm = np.linspace(36, 47, 12, dtype="f4"), np.linspace(6, 19, 14, dtype="f4"), np.arange(4, dtype="f8")
    temp = (15 + np.random.default_rng(2).normal(0, 3, (4, 12, 14))).astype(">f4")
    NC_DIM, NC_VAR, NC_ATT, CHAR, FLOAT, DOUBLE = 10, 11, 12, 2, 5, 6

    def name(s):
        b = s.encode()
        return struct.pack(">i", len(b)) + b + b"\0" * (-len(b) % 4)

    def attrs(d):
        if not d:
            return struct.pack(">ii", 0, 0)
        out = struct.pack(">ii", NC_ATT, len(d))
        for k, v in d.items():
            b = v.encode()
            out += name(k) + struct.pack(">ii", CHAR, len(b)) + b + b"\0" * (-len(b) % 4)
        return out
    dims = [("time", 0), ("lat", 12), ("lon", 14)]
    vars_ = [("time", [0], DOUBLE, tm.astype(">f8"), {"units": "days since 2026-10-01"}, True),
             ("lat", [1], FLOAT, lat.astype(">f4"), {"units": "degrees_north"}, False),
             ("lon", [2], FLOAT, lon.astype(">f4"), {"units": "degrees_east"}, False),
             ("temp", [0, 1, 2], FLOAT, temp, {"units": "degC", "long_name": "Temperatura a 2 m"}, True)]
    head = b"CDF\x01" + struct.pack(">i", 4)
    head += struct.pack(">ii", NC_DIM, len(dims)) + b"".join(name(n) + struct.pack(">i", s) for n, s in dims)
    head += attrs({"title": "Temperature sintetiche Italia", "Conventions": "CF-1.6"})
    fixed = [v for v in vars_ if not v[5]]
    rec = [v for v in vars_ if v[5]]
    rec_size = [v[3][0].nbytes if v[3].ndim > 1 else v[3].itemsize for v in rec]

    def var_block(offsets):
        out = struct.pack(">ii", NC_VAR, len(vars_))
        for (n, dimids, typ, data, at, isrec), off in zip(vars_, offsets):
            vsize = (data[0].nbytes if data.ndim > 1 else data.itemsize) if isrec else data.nbytes
            out += name(n) + struct.pack(">i", len(dimids)) + b"".join(struct.pack(">i", d) for d in dimids) + attrs(at)
            out += struct.pack(">iii", typ, vsize + (-vsize % 4), off)
        return out
    hlen = len(head) + len(var_block([0] * len(vars_)))
    offs, pos = {}, hlen
    for v in fixed:
        offs[v[0]] = pos
        pos += v[3].nbytes + (-v[3].nbytes % 4)
    rpos = pos
    for v, s in zip(rec, rec_size):
        offs[v[0]] = rpos
        rpos += s
    body = head + var_block([offs[v[0]] for v in vars_])
    for v in fixed:
        body += v[3].tobytes() + b"\0" * (-v[3].nbytes % 4)
    for r in range(4):
        for v in rec:
            body += v[3][r:r + 1].tobytes()  # fetta, non scalare: resta big-endian
    body = body[:4] + struct.pack(">i", 4) + body[8:]
    path.write_bytes(body)


TIKA = "https://raw.githubusercontent.com/apache/tika/main/tika-parsers/"
PUBBLICI = {  # file di prova pubblici (licenza Apache-2.0, vedi tests/samples/fx/pubblici/FONTI.md)
    **{f: TIKA + "tika-parsers-standard/tika-parsers-standard-modules/tika-parser-apple-module/src/test/resources/test-documents/" + f
       for f in ("testPages.pages", "testPages2013.pages", "testNumbers.numbers", "testNumbers2013.numbers", "testKeynote2013.key", "testKeynote2018.key")},
    "testICalendar.ics": TIKA + "tika-parsers-standard/tika-parsers-standard-integration-tests/src/test/resources/test-documents/testICalendar.ics",
    "testRSAKEYandCERT.p12": TIKA + "tika-parsers-standard/tika-parsers-standard-modules/tika-parser-crypto-module/src/test/resources/test-documents/testRSAKEYandCERT.p12",
    "sresa1b.nc": TIKA + "tika-parsers-extended/tika-parser-scientific-module/src/test/resources/test-documents/sresa1b_ncar_ccsm3_0_run1_200001.nc",
    "Empty-Metric.rvt": "https://raw.githubusercontent.com/DynamoDS/DynamoRevit/master/test/System/Empty-Metric.rvt",
    "withModelText.rfa": "https://raw.githubusercontent.com/DynamoDS/DynamoRevit/master/test/System/withModelText.rfa",
}


def pubblici():
    import urllib.request
    d = OUT / "pubblici"
    d.mkdir(parents=True, exist_ok=True)
    for name, url in PUBBLICI.items():
        if not (d / name).exists():
            with urllib.request.urlopen(url, timeout=60) as r:
                (d / name).write_bytes(r.read())
            print("scaricato", name)


if __name__ == "__main__":
    import sys
    OUT.mkdir(parents=True, exist_ok=True)
    for fn in (dicom, pim, certs, plotter, scidata) + ((pubblici,) if "--pubblici" in sys.argv else ()):
        fn()
        print("ok", fn.__name__)
