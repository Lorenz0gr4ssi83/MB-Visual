"""Campioni per il collaudo delle pratiche edilizie (tests/test_edilizia.py).

Scrive in tests/samples/edilizia:
- visura_fabbricati.pdf: visura per immobile (Catasto Fabbricati) con l'impaginazione delle visure dell'Agenzia delle
  Entrate - dati della richiesta, intestati, tabella dell'unita' immobiliare con le celle come testi separati,
  indirizzo. Dati di fantasia (codici fiscali validi solo nel formato).
- visura_terreni.pdf: visura Catasto Terreni con un intestatario societa'.
L'anagrafica di prova (esempio.mbcomm) e' scritta a mano ed e' gia' nella cartella.

    python tools/make_edilizia_samples.py
"""
from pathlib import Path

import pymupdf

OUT = Path(__file__).resolve().parent.parent / "tests" / "samples" / "edilizia"


def _page(doc):
    page = doc.new_page(width=595, height=842)
    return page


def _t(page, x, y, s, size=8, bold=False):
    page.insert_text((x, y), s, fontname="hebo" if bold else "helv", fontsize=size)


def fabbricati(path):
    doc = pymupdf.open()
    p = _page(doc)
    _t(p, 40, 40, "Direzione Provinciale di Bergamo", 9, True)
    _t(p, 40, 52, "Ufficio Provinciale - Territorio")
    _t(p, 40, 62, "Servizi Catastali")
    _t(p, 400, 40, "Data: 22/10/2026 - Ora: 10.15.32")
    _t(p, 400, 52, "Visura n.: T123456 Pag: 1")
    _t(p, 230, 90, "Visura per immobile", 12, True)
    _t(p, 210, 104, "Situazione degli atti informatizzati al 22/10/2026")
    _t(p, 40, 130, "Dati della richiesta", 8, True)
    _t(p, 140, 130, "Comune di BERGAMO ( Codice: A794)")
    _t(p, 140, 142, "Provincia di BERGAMO")
    _t(p, 40, 156, "Catasto Fabbricati", 8, True)
    _t(p, 140, 156, "Foglio: 41 Particella: 1234 Sub.: 7")
    _t(p, 40, 180, "INTESTATI", 8, True)
    _t(p, 40, 194, "1")
    _t(p, 52, 194, "BIANCHI GIULIA nata a BERGAMO (BG) il 01/01/1980")
    _t(p, 300, 194, "BNCGLI80A41A794K*")
    _t(p, 420, 194, "(1) Proprieta' 1/2")
    _t(p, 40, 206, "2")
    _t(p, 52, 206, "VERDI PAOLO nato a SERIATE (BG) il 12/03/1978")
    _t(p, 300, 206, "VRDPLA78C12A794X*")
    _t(p, 420, 206, "(1) Proprieta' 1/2")
    _t(p, 40, 232, "Unità immobiliare dal 09/11/2015", 8, True)
    heads = ["N.", "Sezione Urbana", "Foglio", "Particella", "Sub", "Zona Cens.", "Micro Zona", "Categoria", "Classe",
             "Consistenza", "Superficie Catastale", "Rendita"]
    xs = [40, 60, 110, 145, 190, 215, 250, 285, 325, 355, 405, 480]
    for x, h in zip(xs, heads):
        _t(p, x, 248, h, 6.5, True)
    row = ["1", "", "41", "1234", "7", "2", "", "A/2", "3", "5,5 vani", "Totale: 110 m²", "Euro 795,34"]
    for x, v in zip(xs, row):
        _t(p, x, 262, v, 7)
    _t(p, 40, 284, "Indirizzo", 8, True)
    _t(p, 140, 284, "VIA GIUSEPPE GARIBALDI n. 12 Piano 2 Interno 5")
    _t(p, 40, 300, "Annotazioni", 8, True)
    _t(p, 140, 300, "classamento e rendita validati")
    doc.save(path)


def terreni(path):
    doc = pymupdf.open()
    p = _page(doc)
    _t(p, 230, 60, "Visura per immobile", 12, True)
    _t(p, 40, 100, "Dati della richiesta", 8, True)
    _t(p, 140, 100, "Comune di SAN PELLEGRINO TERME ( Codice: H910)")
    _t(p, 140, 112, "Provincia di BERGAMO")
    _t(p, 40, 126, "Catasto Terreni", 8, True)
    _t(p, 140, 126, "Foglio: 5 Particella: 120")
    _t(p, 40, 150, "INTESTATO", 8, True)
    _t(p, 52, 164, "IMMOBILIARE OROBICA S.R.L. con sede in BERGAMO (BG) 01234567890*")
    _t(p, 400, 164, "(1) Proprieta' 1/1")
    _t(p, 40, 190, "Qualità Classe Superficie (m²) Reddito Dominicale Agrario", 7, True)
    _t(p, 40, 204, "SEMINATIVO 2 1.250 Euro 8,07 Euro 7,10", 7)
    doc.save(path)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    fabbricati(OUT / "visura_fabbricati.pdf")
    terreni(OUT / "visura_terreni.pdf")
    print("scritti", OUT)
