"""Prova dell'interfaccia degli archivi cloud senza account reali: server dell'app + finto Dropbox/OneDrive (vedi
tests/test_cloud.py). Il "browser" dell'accesso e' simulato: 1,5 s dopo la richiesta il finto fornitore rimanda
all'indirizzo di ritorno. Stampa l'indirizzo da aprire (modalita' browser).

    python tests/cloud_demo.py
"""
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_cloud as T  # noqa: E402  (imposta MBV_CLOUD_DIR in una cartella temporanea)

from mbvisual import cloud  # noqa: E402
from mbvisual.server import TOKEN, start_server  # noqa: E402

fake = ThreadingHTTPServer(("127.0.0.1", 0), T.H)
threading.Thread(target=fake.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{fake.server_address[1]}"
db, gr = cloud.PROVIDERS["dropbox"], cloud.PROVIDERS["onedrive"]
db.API, db.CONTENT, db.TOKEN, db.AUTH = base + "/2", base + "/2", base + "/oauth2/token", base + "/oauth2/authorize"
gr.API, gr.LOGIN = base + "/v1.0", base
cloud.set_config({"servizi": {"dropbox": {"client_id": "id-prova"}, "onedrive": {"client_id": "id-prova"}}, "porta": T.free_port()})
cloud.webbrowser.open = lambda url: threading.Timer(1.5, lambda: T.browser(url)).start()
T.Fake.files = {"/progetti/note cantiere.txt": {"data": "Note del cantiere\nriga 2\n".encode(), "rev": "a1"},
                "/relazione.md": {"data": "# Relazione\n\nTesto di prova.\n".encode(), "rev": "b1"}}
T.Fake.graph = {"I1": {"name": "computo.csv", "data": b"voce;quantita\nscavo;12\n", "ctag": "c1", "parent": "root"}}

srv, port = start_server()
print(f"http://127.0.0.1:{port}/?t={TOKEN}", flush=True)
print("finto fornitore:", base, flush=True)
while True:
    time.sleep(3600)
