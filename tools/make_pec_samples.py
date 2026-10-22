"""Messaggi PEC di esempio (busta di posta certificata, ricevute di accettazione, consegna, mancata consegna, non
accettazione) con daticert.xml e firma S/MIME di un gestore di prova: tests/samples/pec/*.eml.

    python tools/make_pec_samples.py
"""
import sys
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import pecsim  # noqa: E402

OUT = ROOT / "tests" / "samples" / "pec"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    m = EmailMessage()
    m["From"] = "Studio Tecnico <studio@pec.prova.it>"
    m["To"] = "Comune di Prova <protocollo@pec.prova.it>"
    m["Subject"] = "Trasmissione integrazioni pratica SCIA 2026/123"
    m["Date"] = formatdate(time.time(), localtime=True)
    m["Message-ID"] = make_msgid(domain="pec.prova.it")
    m.set_content("Si trasmettono in allegato le integrazioni richieste.\n\nCordiali saluti")
    pdf = next((ROOT / "tests" / "samples").rglob("*.pdf"), None)
    if pdf:
        m.add_attachment(pdf.read_bytes(), maintype="application", subtype="pdf", filename="integrazioni.pdf")
    raw = m.as_bytes()
    subj, msgid = str(m["Subject"]), str(m["Message-ID"])
    dest = ["protocollo@pec.prova.it", "ufficio.tecnico@pec.prova.it", "geometra@esterno.it"]
    files = {
        "01_posta_certificata.eml": pecsim.busta(raw, "studio@pec.prova.it", dest, subj, msgid, str(m["To"])),
        "02_ricevuta_accettazione.eml": pecsim.ricevuta("accettazione", None, "studio@pec.prova.it", dest, subj, msgid),
        "03_ricevuta_avvenuta_consegna.eml": pecsim.ricevuta("avvenuta-consegna", raw, "studio@pec.prova.it", dest, subj, msgid,
                                                             consegna="protocollo@pec.prova.it"),
        "04_avviso_mancata_consegna.eml": pecsim.ricevuta("errore-consegna", None, "studio@pec.prova.it", dest, subj, msgid,
                                                          consegna="ufficio.tecnico@pec.prova.it", errore="no-dest",
                                                          errore_esteso="5.1.1 - Destinatario inesistente"),
        "05_avviso_non_accettazione.eml": pecsim.ricevuta("non-accettazione", None, "studio@pec.prova.it", dest, subj, msgid, errore="altro",
                                                          errore_esteso="Messaggio non conforme"),
        "00_messaggio_originale.eml": raw,
    }
    for name, data in files.items():
        (OUT / name).write_bytes(data)
    (OUT / "LEGGIMI.txt").write_text("Messaggi PEC di prova generati da tools/make_pec_samples.py con un gestore simulato (tests/pecsim.py):\n"
                                     "firma S/MIME con un certificato autofirmato creato al momento, daticert.xml come da regole tecniche.\n"
                                     "Non hanno valore legale.\n", "utf-8")
    print(f"{len(files)} file in {OUT}")


if __name__ == "__main__":
    main()
