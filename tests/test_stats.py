"""Collaudo delle statistiche d'uso anonime (mbvisual/stats.py) con un server finto che registra ogni richiesta.

Uso: python tests/test_stats.py
Verifica che senza consenso non si conti e non parta nulla, che con il consenso partano solo i giorni conclusi e solo i
dati previsti (niente percorsi o nomi), che la revoca cancelli i conteggi e chieda la cancellazione al server.
"""
import json
import os
import sys
import tempfile
import threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
TMP = Path(tempfile.mkdtemp(prefix="mbv-stat-"))
os.environ["MBV_STATISTICHE"] = str(TMP / "statistiche.json")

seen = []


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        seen.append((self.path, body, dict(self.headers)))
        out = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["MBV_STAT_URL"] = f"http://127.0.0.1:{srv.server_address[1]}"

from mbvisual import stats  # noqa: E402

stats._started = True  # niente thread di invio in background: gli invii li fa la prova con send_now()

fails = 0


def ok(cond, label, extra=""):
    global fails
    print(("OK   " if cond else "NO   ") + label + (f"  {extra}" if extra else ""))
    if not cond:
        fails += 1


def load():
    return json.loads(Path(os.environ["MBV_STATISTICHE"]).read_text(encoding="utf-8"))


# ---- nessuna scelta: predefinito no
st = stats.status()
ok(st["consenso"] is False and st["chiesto"] is False, "predefinito: nessun consenso, finestra da mostrare")
stats.track({"exts": {"pdf": 3}, "funcs": {"stampa": 1}, "seconds": 60})
ok(not Path(os.environ["MBV_STATISTICHE"]).exists(), "senza consenso track() non salva nulla")
stats.on_launch()
ok(not Path(os.environ["MBV_STATISTICHE"]).exists(), "senza consenso l'avvio non conta nulla")
r = stats.send_now()
ok(r["inviati"] == 0 and not seen, "senza consenso nessuna richiesta al server")

# ---- rifiuto esplicito
stats.set_consent(False)
ok(stats.status() == {**stats.status(), "consenso": False, "chiesto": True}, "rifiuto registrato (la finestra non torna)")
stats.track({"exts": {"pdf": 1}})
stats.send_now()
ok(not seen and "inst" not in load() and not load().get("giorni"), "dopo il No: niente identificativo, niente conteggi, niente richieste")

# ---- consenso
stats.set_consent(True)
d = load()
inst1 = d["inst"]
ok(len(inst1) == 32 and all(c in "0123456789abcdef" for c in inst1), "consenso: identificativo casuale di 32 cifre esadecimali")
from mbvisual import license as lic  # noqa: E402
ok(inst1 != lic.device_id() and inst1 not in lic.device_id(), "l'identificativo non e' l'impronta della licenza")
stats.track({"lang": "it", "seconds": 120, "exts": {"pdf": 2, "dwg": 1, "C:\\Users\\nome\\file.dwg": 1, "rossi progetto": 1},
             "funcs": {"stampa": 1, "nav.clash": 2, "<b>": 1}, "errors": {"cad2d|TypeError|dwg": 1, "messaggio con testo": 1}})
today = date.today().isoformat()
row = load()["giorni"][today]
ok(row["exts"] == {"pdf": 2, "dwg": 1} and row["funcs"] == {"stampa": 1, "nav.clash": 2} and row["errors"] == {"cad2d|TypeError|dwg": 1},
   "solo chiavi del formato previsto (percorsi, nomi e testi scartati)", json.dumps(row["exts"]))
ok(row["launches"] == 1 and row["seconds"] == 120 and row["lang"] == "it" and row["version"] and row["os"] and row["arch"], "avvio, durata, lingua, versione, sistema")
stats.send_now()
ok(not seen, "il giorno in corso non parte (si invia a giorno concluso)")
# giorno di ieri (simulato)
d = load()
d["giorni"][(date.today() - timedelta(days=1)).isoformat()] = {**row, "launches": 3}
d["giorni"][(date.today() - timedelta(days=60)).isoformat()] = {**row}
Path(os.environ["MBV_STATISTICHE"]).write_text(json.dumps(d), encoding="utf-8")
stats.on_launch()  # nuovo avvio: scarta i giorni oltre 40 e conta l'avvio
r = stats.send_now()
ok(r["inviati"] == 1 and len(seen) == 1 and seen[0][0] == "/v1/stats", "con il consenso: inviato solo il giorno concluso", f"{r}")
body = seen[0][1]
text = json.dumps(body)
ok(set(body) == {"inst", "days"} and body["inst"] == inst1 and body["days"][0]["launches"] == 3, "pacchetto: identificativo + giorni")
ok(not any(x in text for x in ("Users", "nome", "rossi", lic.device_id(), os.environ.get("USERNAME", "@@"), os.environ.get("COMPUTERNAME", "@@"))),
   "nel pacchetto nessun percorso, nome utente, nome del PC o impronta")
ok("authorization" not in {k.lower() for k in seen[0][2]} and "cookie" not in {k.lower() for k in seen[0][2]}, "nessun token di licenza o cookie nella richiesta")
ok(list(load()["giorni"]) == [today], "giorno inviato tolto dai conteggi locali; giorni oltre 40 scartati")

# ---- revoca
stats.set_consent(False)
d = load()
ok(not d.get("giorni") and "inst" not in d and d.get("da_cancellare") == [inst1], "revoca: conteggi locali cancellati, richiesta di cancellazione in coda")
seen.clear()
r = stats.send_now()
ok(r["cancellazioni"] == 1 and seen and seen[0][0] == "/v1/stats/forget" and seen[0][1] == {"inst": inst1} and len(seen) == 1,
   "revoca: inviata solo la richiesta di cancellazione")
ok(not load().get("da_cancellare"), "cancellazione confermata: niente da ripetere")
seen.clear()
stats.track({"exts": {"pdf": 1}})
stats.send_now()
ok(not seen, "dopo la revoca nessun altro invio")

# ---- nuovo consenso: identificativo nuovo
stats.set_consent(True)
ok(load()["inst"] != inst1, "nuovo consenso: identificativo nuovo (i dati vecchi non si collegano)")

# ---- server non raggiungibile: la cancellazione resta in coda
stats.set_consent(False)
os.environ["MBV_STAT_URL"] = "http://127.0.0.1:9"
stats.send_now()
ok(len(load().get("da_cancellare", [])) == 1, "server non raggiungibile: la richiesta di cancellazione si ripete al prossimo giro")

srv.shutdown()
print(f"\n{fails} prove NON riuscite" if fails else "\nTutte le prove riuscite")
sys.exit(1 if fails else 0)
