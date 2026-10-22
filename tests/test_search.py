"""Collaudo della ricerca nel progetto: indicizza la cartella creata da tests/make_search_samples.py e verifica le ricerche.

    python tests/test_search.py <cartella> [--nuovo]

--nuovo cancella prima l'indice (prima indicizzazione completa). Riporta tempi, stati dei file e l'esito di ogni ricerca.
"""
import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from mbvisual import search  # noqa: E402

# ricerca -> (file atteso, controllo sulla posizione trovata o None)
CASES = [
    ("ZEBRA-PDF-03", "Relazione_calcolo.pdf", lambda l: l.get("page") == 3),
    ('"trave ZEBRA-PDF-03 in acciaio"', "Relazione_calcolo.pdf", lambda l: l.get("page") == 3),
    ("Mario Rossi", "Relazione_calcolo.pdf", None),
    ("ZEBRA-OCR-01", "Verbale_OCR.pdf", lambda l: l.get("page") == 1),
    ("ZEBRA-DOCX-02", "Capitolato.docx", None),
    ("ZEBRA-INTEST", "Capitolato.docx", None),
    ("ZEBRA-XLSX-B37", "Computo_metrico.xlsx", lambda l: l.get("cell") == "B37" and l.get("sheet") == "Computo"),
    ("ZEBRA-XLSX-RIEP", "Computo_metrico.xlsx", lambda l: l.get("cell") == "C4" and l.get("sheet") == "Riepilogo"),
    ("ZEBRA-PPTX-04", "Presentazione_SAL.pptx", lambda l: l.get("slide") == 4),
    ("ZEBRA-NOTE-02", "Presentazione_SAL.pptx", lambda l: l.get("slide") == 2),
    ("ZEBRA-ODT-01", "Verbale.odt", None),
    ("ZEBRA-ODS-C2", "Tabella.ods", lambda l: l.get("cell") == "C2"),
    ("ZEBRA-RTF-01", "Lettera.rtf", None),
    ("ZEBRA-DOC-97", "Vecchio_documento.doc", None),
    ("ZEBRA-XLS-97", "Vecchio_foglio.xls", None),
    ("ZEBRA-TXT-300", "note_cantiere.txt", lambda l: l.get("line") == 300),
    ("ZEBRA-MD-01", "LEGGIMI.md", None),
    ("ZEBRA-CSV-01", "elenco.csv", lambda l: l.get("line") == 2),
    ("ZEBRA-HTML-01", "pagina.html", None),
    ("ZEBRA-PY-01", "calcolo.py", lambda l: l.get("line") == 2),
    ("citta perche", "Città_perché.txt", None),  # senza accenti trova le parole accentate
    ("ZEBRA-EML-OGGETTO", "Invio_documentazione.eml", None),
    ("ZEBRA-PDF-03", "Invio_documentazione.eml", lambda l: l.get("attach") == "Relazione_allegata.pdf" and l.get("page") == 3),
    ("ZEBRA-DOCX-02", "Invio_documentazione.eml", lambda l: l.get("attach") == "Capitolato_allegato.docx"),
    ("ZEBRA-DXF-TEXT", "Pianta_PT.dxf", lambda l: bool(l.get("handle"))),
    ("ZEBRA-DXF-MTEXT", "Pianta_PT.dxf", lambda l: bool(l.get("handle"))),
    ("ZEBRA-DXF-ATTRIB", "Pianta_PT.dxf", lambda l: bool(l.get("handle"))),
    ("ZEBRA-LAYER-ARREDI", "Pianta_PT.dxf", None),
    ("ZEBRA-IFC-TAG", "Edificio.ifc", lambda l: l.get("ifc") == 10),
    ("ZEBRA-IFC-PSET", "Edificio.ifc", lambda l: l.get("ifc") == 10),
    ("ZEBRA-IFC-MAT", "Edificio.ifc", lambda l: l.get("ifc") == 10),
    ('"Piano terra" porta', "Edificio.ifc", lambda l: l.get("ifc") == 11),
    ("NetSideArea", "Edificio.ifc", lambda l: l.get("ifc") == 11),
    ("accento parete", "Edificio.ifc", lambda l: l.get("ifc") == 60),
    ("ZEBRA-EXIF-ARTIST", "Foto_sopralluogo.jpg", None),
    ("ZEBRA-EXIF-KEYWORD", "Foto_sopralluogo.jpg", None),
    ("ZEBRA-PNG-TEXT", "Schema.png", None),
    ("ZEBRA-ZIP-TAVOLA-01", "Consegna.zip", None),
    ("ZEBRA-NUVOLA-NOME", "Solo_online_ZEBRA-NUVOLA-NOME.pdf", None),
    ("Capitol*", "Capitolato.docx", None),  # prefisso
    ("serramenti alluminio", "Capitolato.docx", None),  # piu' parole
    ("pompa OR valvola", "pagina.html", None),
]
NEGATIVE = ["ZEBRA-NUVOLA-CONTENUTO", "ZEBRA-SEGRETO", "nascosto"]  # contenuto da NON trovare


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--nuovo", action="store_true")
    a = ap.parse_args()
    root = search.norm_root(a.folder)
    if a.nuovo:
        p = search.db_path(root)
        for f in p.parent.glob(p.name + "*"):
            f.unlink()
    ix = search.indexer(root)
    t0 = time.time()
    ix.update()
    while ix.thread.is_alive():
        time.sleep(0.5)
    st = search.status(root)
    print(f"Indicizzazione: {time.time() - t0:.1f} s (CPU del thread {ix.st.get('cpu')} s) · file nella cartella {st['trovati']} · letti ora {st['da_fare']} "
          f"({st.get('letti_mb', 0)} MB) · stati {st.get('stati')} · indice {st.get('dimensione', 0) / 1048576:.1f} MB")
    # DWG: in assenza dell'interfaccia restano "da leggere"
    print("DWG in attesa dell'interfaccia:", search.dwg_pending(root)["restanti"])
    ok = 0
    times = []
    for q, name, check in CASES:
        t = time.time()
        r = search.search(root, q, sub="Commessa_2026-101")  # i file originali (le copie in Archivio_commesse li ripetono)
        times.append((time.time() - t) * 1000)
        hits = [f for f in r["files"] if f["name"] == name]
        good = bool(hits) and (check is None or any(check(h["loc"]) for h in hits[0]["hits"]))
        ok += good
        loc = hits[0]["hits"][0] if hits and hits[0]["hits"] else {}
        print(f"{'OK ' if good else 'NO '} {q:34} -> {r['totale']:4} file · {times[-1]:6.1f} ms · {name}: {loc.get('label', '-')!s:45} "
              f"{(loc.get('snippet') or '').replace(chr(2), '[').replace(chr(3), ']')[:90]!r}")
    for q in NEGATIVE:
        r = search.search(root, q)
        good = r["totale"] == 0
        ok += good
        print(f"{'OK ' if good else 'NO '} (non deve trovare) {q:24} -> {r['totale']} file")
    # filtri
    r = search.search(root, "ZEBRA*", kind="pdf")
    good = r["files"] and all(f["kind"] == "pdf" for f in r["files"])
    ok += bool(good)
    print(f"{'OK ' if good else 'NO '} filtro tipo pdf -> {r['totale']} file")
    r = search.search(root, "ZEBRA*", sub="Commessa_2026-101/03_Disegni")
    good = r["files"] and all(f["rel"].startswith("Commessa_2026-101/03_Disegni/") for f in r["files"])
    ok += bool(good)
    print(f"{'OK ' if good else 'NO '} filtro cartella -> {r['totale']} file")
    r = search.search(root, "calcestruzzo", dfrom=time.time() - 86400)
    print(f"    filtro data (ultime 24 h) 'calcestruzzo' -> {r['totale']} file in {r['ms']} ms")
    r = search.search(root, "trave")
    print(f"    ricerca larga 'trave' -> {r['totale']} file in {r['ms']} ms")
    n = len(CASES) + len(NEGATIVE) + 2
    print(f"\nEsito: {ok}/{n} · tempo medio di ricerca {sum(times) / len(times):.1f} ms, massimo {max(times):.1f} ms")
    # secondo passaggio: nessun file cambiato -> solo controllo delle date
    t0 = time.time()
    ix.update()
    while ix.thread.is_alive():
        time.sleep(0.2)
    print(f"Aggiornamento senza modifiche: {time.time() - t0:.2f} s, file riletti {ix.st['da_fare']}")
    f = Path(root) / "Commessa_2026-101" / "07_Varie" / "LEGGIMI.md"
    f.write_text(f.read_text(encoding="utf-8") + "\nAggiunta ZEBRA-MODIFICA\n", encoding="utf-8")
    t0 = time.time()
    ix.update()
    while ix.thread.is_alive():
        time.sleep(0.2)
    r = search.search(root, "ZEBRA-MODIFICA")
    print(f"Aggiornamento dopo una modifica: {time.time() - t0:.2f} s, file riletti {ix.st['da_fare']}, trovato: {r['totale'] == 1}")
    return 0 if ok == n else 1


if __name__ == "__main__":
    sys.exit(main())
