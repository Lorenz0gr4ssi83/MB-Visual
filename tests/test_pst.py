"""Archivi di Outlook .pst/.ost (mbvisual/pst.py): indice e TUTTI i messaggi letti, allegati estratti.
Uso: python tests/test_pst.py <file.pst|cartella>...  (campioni pubblici: java-libpst src/test/resources, pst-extractor testdata)"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from mbvisual import misc  # noqa: E402


def files(args):
    for a in args:
        if os.path.isdir(a):
            yield from (os.path.join(a, f) for f in sorted(os.listdir(a)) if f.lower().endswith((".pst", ".ost")))
        else:
            yield a


ok = bad = 0
for p in files(sys.argv[1:]):
    r = misc.read_email(p)
    assert r["pst"], p
    errs = 0
    for i in range(len(r["messaggi"])):
        try:
            m = misc.read_email(p, i)["messaggio"]
            for a in m["allegati"]:
                assert a["path"] is None or os.path.getsize(a["path"]) == a["size"]
        except Exception as e:  # noqa: BLE001
            errs += 1
            print("  ERRORE", i, e)
    print(f"{'OK ' if not errs else 'NO '} {os.path.basename(p)}: {len(r['messaggi'])} messaggi, {len(r['cartelle'])} cartelle, {errs} errori")
    ok += not errs
    bad += bool(errs)
print(f"{ok} archivi letti per intero, {bad} con errori")
sys.exit(1 if bad else 0)
