"""Registra in ui/formats.json i formati aggiunti con mbvisual/formati.py (DICOM, calendari, contatti, certificati,
Apple iWork, plotter HPGL, dati scientifici/tabellari, Revit). Si puo' rilanciare: toglie e rimette le stesse voci.
Uso: python tools/add_fx_formats.py  (poi python tools/gen_elenco.py)
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
P = ROOT / "ui" / "formats.json"

NEW = [
    {"id": "dicom", "name": "Immagini mediche DICOM", "viewer": "dicom",
     "view": "Serie della cartella (o DICOMDIR) con scorrimento tra le sezioni e riproduzione, finestra/livello con preimpostazioni TC, "
             "inversione, zoom, misure di distanza e angolo, ROI con media/deviazione/area, valore del pixel (HU), tag DICOM in tabella con ricerca; "
             "anche compressi JPEG, JPEG lossless, JPEG-LS, JPEG 2000, RLE e multi-fotogramma",
     "edit": "Esportazione della sezione attuale o di tutte le sezioni in PNG/JPG (con le misure) e dei tag in CSV",
     "exts": ["dcm", "dicom"]},
    {"id": "calendar", "name": "Calendari iCalendar", "viewer": "calendar",
     "view": "Eventi in elenco con ricerca e in vista mese (anche eventi ripetuti, giornate intere, promemoria, partecipanti, attivita')",
     "edit": "Esportazione in PDF, CSV ed Excel",
     "exts": ["ics", "ical", "icalendar", "ifb", "vcs"]},
    {"id": "contacts", "name": "Contatti vCard", "viewer": "contacts",
     "view": "Schede dei contatti con foto, telefoni, email, indirizzi, azienda, note; ricerca (vCard 2.1, 3.0 e 4.0, anche piu' contatti per file)",
     "edit": "Esportazione in CSV ed Excel",
     "exts": ["vcf", "vcard"]},
    {"id": "cert", "name": "Certificati digitali", "viewer": "cert",
     "view": "Soggetto, emittente, validita', numero di serie, impronte SHA-1/SHA-256, chiave pubblica, usi della chiave, estensioni, "
             "catena di certificazione con verifica delle firme tra i certificati; PKCS#12 (.p12/.pfx) con password usata solo per la lettura e mai conservata; "
             "richieste di certificato (CSR) ed elenchi di revoca (CRL)",
     "edit": "Esportazione dei soli dati pubblici: certificati in PEM, DER/CER, PKCS#7 (.p7b) e riepilogo in testo",
     "exts": ["cer", "crt", "pem", "der", "p7b", "p12", "pfx", "csr", "crl"]},
    {"id": "iwork", "name": "Apple iWork (Pages, Numbers, Keynote)", "viewer": "iwork",
     "view": "Anteprima incorporata nel documento (pagina o PDF di anteprima), immagini contenute, testo del documento e tabelle (Numbers) letti dal file",
     "edit": "Esportazione dell'anteprima in PDF/PNG, del testo in TXT e delle tabelle in CSV/Excel",
     "exts": ["pages", "numbers", "key"]},
    {"id": "hpgl", "name": "File di plotter HP-GL / HP-GL/2", "viewer": "hpgl",
     "view": "Disegno vettoriale con penne colorate e spessori, testi (LB), archi e cerchi, poligoni pieni; zoom, misura, accensione/spegnimento delle penne",
     "edit": "Esportazione in PDF e SVG vettoriali e in PNG",
     "exts": ["plt", "hpgl", "hgl", "hpg"]},
    {"id": "scidata", "name": "Dati scientifici e tabellari (HDF5, NetCDF, Parquet, Arrow)", "viewer": "scidata",
     "view": "Struttura (gruppi, dataset, variabili, dimensioni, attributi, schema e metadati), anteprima dei dati a pagine con grafico per i valori numerici",
     "edit": "Esportazione di tabelle, dataset e variabili in CSV ed Excel",
     "exts": ["h5", "hdf5", "he5", "nc", "nc4", "parquet", "feather", "arrow"]},
    {"id": "revit", "name": "Autodesk Revit", "viewer": "revit",
     "view": "Anteprima incorporata nel file e informazioni senza Revit: versione e build di Revit, file centrale/locale, condivisione, autore, "
             "percorso del modello centrale, identificativi; per le famiglie categoria, tipi e parametri dichiarati",
     "edit": "Esportazione dell'anteprima in PNG e delle informazioni in TXT/JSON",
     "exts": ["rvt", "rfa", "rte", "rft"]},
]
# estensioni che prima andavano solo nell'editor di testo o nel visualizzatore delle firme
MOVE_FROM = {"text": {"ics", "ical", "vcf", "vcard", "cer", "crt", "pem", "csr"}, "signed": {"p7b"}}


def main():
    raw = P.read_bytes().decode("utf-8")
    reg = json.loads(raw)
    ids = {c["id"] for c in NEW}
    cats = [c for c in reg["categories"] if c["id"] not in ids]
    for c in cats:
        drop = MOVE_FROM.get(c["id"])
        if drop:
            c["exts"] = [e for e in c["exts"] if e not in drop]
    cats.extend(json.loads(json.dumps(NEW)))
    reg["categories"] = cats
    P.write_bytes((json.dumps(reg, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))
    print("Registrate", sum(len(c["exts"]) for c in NEW), "estensioni in", len(NEW), "categorie")


if __name__ == "__main__":
    main()
