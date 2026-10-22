"""Collaudo dei motori dei formati aggiunti (mbvisual/formati.py) sui file di tests/samples/fx.

Uso: python tests/test_fx_formats.py   (prima: python tools/make_fx_samples.py)
I file in tests/samples/fx/pubblici sono esempi pubblici (vedi FONTI.md); calendari, contatti e HP-GL si leggono nel
browser (ui/js/pim.js, ui/js/hpgl.js): qui si controlla solo che i file esistano.
"""
import os
import sys
import tempfile
import warnings

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
S = os.path.join(ROOT, "tests", "samples", "fx")
P = os.path.join(S, "pubblici")
warnings.simplefilter("ignore")

from mbvisual import fx_cert, fx_dicom, fx_iwork, fx_revit, fx_sci, misc  # noqa: E402

ok = fail = 0


def check(name, cond, info=""):
    global ok, fail
    if cond:
        ok += 1
        print("OK  ", name, info)
    else:
        fail += 1
        print("ERR ", name, info)


def run(name, fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        check(name, False, repr(e))


def t_dicom():
    r = fx_dicom.open_series(os.path.join(S, "dicom_serie_tc", "IM0005.dcm"))
    check("dicom serie", len(r["fotogrammi"]) == 24 and r["indice"] == 4, f"{len(r['fotogrammi'])} sezioni")
    data, h = fx_dicom.frame(r["sezioni"][0]["path"], 0)
    check("dicom pixel HU", h["X-T"] == "i16" and len(data) == int(h["X-W"]) * int(h["X-H"]) * 2)
    r = fx_dicom.open_series(os.path.join(S, "emri_small.dcm"))
    check("dicom multi-fotogramma", len(r["fotogrammi"]) == 10)
    check("dicom tag", len(fx_dicom.tags(os.path.join(S, "CT_small.dcm"))["tag"]) > 100)
    check("dicom senza estensione (sniff)", misc.sniff(os.path.join(S, "dicom_serie_tc", "IM0020"))["kind"] == "dicom")


def t_cert():
    for f, n in (("certificato.crt", 1), ("certificato.cer", 1), ("catena.pem", 3), ("catena.p7b", 3), ("radice.der", 1)):
        r = fx_cert.read(os.path.join(S, f))
        check("cert " + f, len(r["certificati"]) == n)
    r = fx_cert.read(os.path.join(S, "catena.pem"))
    check("cert catena verificata", [a["fonte"] for a in r["catene"][0]["anelli"]] == ["file"] * 3)
    p12 = os.path.join(S, "identita_password_prova.p12")
    check("cert p12 chiede password", fx_cert.read(p12).get("password_richiesta") is True)
    check("cert p12 password errata", fx_cert.read(p12, "no").get("errata") is True)
    r = fx_cert.read(p12, "prova")
    check("cert p12 letto", len(r["certificati"]) == 3)
    out = os.path.join(tempfile.gettempdir(), "mbv_fx.p7b")
    fx_cert.export([c["pem"] for c in r["certificati"]], out)
    check("cert esporta p7b", len(fx_cert.read(out)["certificati"]) == 3)
    check("cert csr", fx_cert.read(os.path.join(S, "richiesta.csr"))["altri"][0]["firma_valida"])
    check("cert crl", len(fx_cert.read(os.path.join(S, "revoche.crl"))["altri"][0]["revocati"]) == 1)


def t_sci():
    r = fx_sci.open_file(os.path.join(S, "misure.h5"))
    check("hdf5 struttura", any(n["nome"] == "/sensori/accelerazione" for n in r["nodi"]))
    d = fx_sci.data(os.path.join(S, "misure.h5"), "/elementi", 0, 10)
    check("hdf5 composto", d["colonne"] == ["id", "nome", "carico_kN"] and d["righe"][4][1] == "Plinto")
    d = fx_sci.data(os.path.join(S, "meteo.nc"), "/time", 0, 10)
    check("netcdf3 variabile record", [x[0] for x in d["righe"]] == [0.0, 1.0, 2.0, 3.0])
    for f in ("ore_commesse.parquet", "ore_commesse.feather", "ore_commesse.arrow"):
        d = fx_sci.data(os.path.join(S, f), "/", 990, 50)
        check(f, d["totale"] == 1000 and len(d["righe"]) == 10)
    out = os.path.join(tempfile.gettempdir(), "mbv_fx.xlsx")
    check("sci esporta xlsx", fx_sci.export(os.path.join(S, "ore_commesse.parquet"), "/", out)["righe"] == 1000)
    nc = os.path.join(P, "sresa1b.nc")
    if os.path.exists(nc):
        d = fx_sci.data(nc, "/tas", 0, 1, [0])
        check("netcdf3 Unidata", 150 < d["righe"][0][0] < 350)


def t_iwork():
    exp = {"testPages.pages": ("Lorem ipsum", 1), "testPages2013.pages": ("Sample pages document", 1), "testNumbers.numbers": ("Checking Account", 2),
           "testNumbers2013.numbers": ("Checking Account", 3), "testKeynote2013.key": ("Some random text", 1), "testKeynote2018.key": ("Libreoffice", 0)}
    for f, (txt, ntab) in exp.items():
        p = os.path.join(P, f)
        if not os.path.exists(p):
            continue
        r = fx_iwork.read(p)
        check("iwork " + f, any(txt in t["testo"] for t in r["testi"]) and len(r["tabelle"]) >= ntab, f"{len(r['tabelle'])} tabelle")
        check("iwork sniff " + f, misc.sniff(p)["kind"] == "iwork")
    p = os.path.join(P, "testNumbers2013.numbers")
    if os.path.exists(p):
        t = fx_iwork.read(p)["tabelle"][0]["righe"]
        check("numbers 2013 celle", t[2][:6] == ["101", "01/10/2009", "Rent", 2, -775, 3875])


def t_revit():
    for f, v in (("Empty-Metric.rvt", "2017"), ("withModelText.rfa", "2016")):
        p = os.path.join(P, f)
        if os.path.exists(p):
            r = fx_revit.read(p)
            check("revit " + f, r["versione"] == v and r["anteprima"], r["tipo"])
    p = os.path.join(P, "withModelText.rfa")
    if os.path.exists(p):
        check("revit famiglia", fx_revit.read(p)["famiglia"]["categorie"] == ["Generic Models"])


for f in ("cantiere.ics", "rubrica.vcf", "pianta_plotter.plt", "spirale_pe.hgl", "schema.hpgl"):
    check("campione " + f, os.path.exists(os.path.join(S, f)))
for fn in (t_dicom, t_cert, t_sci, t_iwork, t_revit):
    run(fn.__name__, fn)
print(f"\n{ok} riuscite, {fail} non riuscite")
sys.exit(1 if fail else 0)
