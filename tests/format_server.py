"""Server dell'app per il collaudo di tutti i formati (tests/test_all_formats.mjs).

Dati dell'app in una cartella di prova: LOCALAPPDATA va impostato PRIMA di importare mbvisual (DATA_DIR lo segue), altrimenti
l'interfaccia avvierebbe la posta sui dati veri. Non tocca l'integrazione con Esplora (non passa da app.py main).
Stampa l'indirizzo da aprire e resta acceso finche' il processo che l'ha avviato non lo chiude.

    python tests/format_server.py <cartella dati di prova>
"""
import os
import sys
import time
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit(__doc__)
data = Path(sys.argv[1]).resolve()
data.mkdir(parents=True, exist_ok=True)
os.environ["LOCALAPPDATA"] = str(data)
os.environ["MBV_STATISTICHE"] = str(data / "statistiche.json")
os.environ["MBV_MAIL_DIR"] = str(data / "posta")
os.environ.setdefault("MBV_CLOUD_DIR", str(data / "cloud"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mbvisual.server import TOKEN, start_server  # noqa: E402

srv, port = start_server()
print(f"http://127.0.0.1:{port}/?t={TOKEN}", flush=True)
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    pass
