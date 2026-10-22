"""Collaudo di calendario e contatti della posta: CalDAV/CardDAV (server di prova tests/davserver.py), inviti alle
riunioni (REQUEST/CANCEL), eventi e rubrica locali.

    python tests/test_mail_cal.py
"""
import json
import os
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="mbv-posta-cal-"))
os.environ["MBV_MAIL_DIR"] = str(TMP / "posta")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import davserver  # noqa: E402
import mailserver  # noqa: E402
from mbvisual.mail import accounts, api, calapi, calsync, engine, ical  # noqa: E402

engine.NO_THREADS[0] = True
OK, FAIL = 0, []


def check(name, cond, info=""):
    global OK
    if cond:
        OK += 1
        print("  ok  ", name)
    else:
        FAIL.append(name)
        print("  NO  ", name, info)


davserver.seed()
DAV, _d = davserver.start()
mailserver.seed()
IP, SP, _m = mailserver.start()
A = accounts.save_account({"email": "mario@studio.prova.it", "nome": "Mario Rossi", "imap": "127.0.0.1", "imap_port": IP, "imap_sec": "none",
                           "smtp": "127.0.0.1", "smtp_port": SP, "smtp_sec": "none", "utente": "mario@studio.prova.it", "password": "prova",
                           "caldav": DAV + "/dav/", "carddav": DAV + "/dav/", "dav_utente": "mario", "dav_password": "prova"})["id"]
acc = accounts.get(A)

print("CalDAV")
calsync.sync_account(acc, force=True)
cals = engine.db().q("SELECT * FROM calendars WHERE account=? AND kind='cal'", (A,))
check("calendario trovato dal principal (VTODO escluso)", len(cals) == 1 and cals[0]["name"] == "Lavoro" and cals[0]["color"] == "#30A46C", cals)
CAL = cals[0]["id"]
evs = {e["uid"]: e for e in engine.db().q("SELECT * FROM events WHERE cal_id=?", (CAL,))}
r = evs.get("riunione-settimanale@prova")
check("evento ricorrente con fuso orario", r and r["rrule"].startswith("FREQ=WEEKLY") and datetime.fromtimestamp(r["start"]).hour == 9, r)
c = evs.get("consegna-24017@prova")
check("evento di una giornata", c and c["allday"] == 1)
res = calapi.events_between({"da": time.time() - 86400 * 400, "a": time.time() + 86400 * 400})
check("eventi per l'interfaccia", len(res["items"]) == 2 and res["calendari"])
s = time.mktime((2026, 11, 3, 15, 0, 0, 0, 0, -1))
out = calsync.save_event_ui({"cal": CAL, "summary": "Sopralluogo Brescia", "location": "Via Roma 1", "start": s, "end": s + 5400})
calsync.sync_account(acc, force=True)
new = [h for h in davserver.Dav.res if h.startswith("/dav/cal/lavoro/") and h not in ("/dav/cal/lavoro/riunione.ics", "/dav/cal/lavoro/consegna.ics")]
check("evento nuovo caricato con PUT", len(new) == 1 and b"Sopralluogo Brescia" in davserver.Dav.res[new[0]][0])
e = engine.db().one("SELECT * FROM events WHERE id=?", (out["id"],))
check("href ed ETag salvati", e["href"].endswith(new[0]) and e["etag"] and e["dirty"] == 0, e)
calsync.save_event_ui({"id": out["id"], "cal": CAL, "summary": "Sopralluogo Brescia (spostato)", "location": "Via Roma 1", "start": s + 3600, "end": s + 9000})
calsync.sync_account(acc, force=True)
check("modifica caricata con If-Match", b"spostato" in davserver.Dav.res[new[0]][0] and b"SEQUENCE:1" in davserver.Dav.res[new[0]][0])
davserver.put("/dav/cal/lavoro/esterno.ics", b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:esterno@prova\r\nDTSTART:20261110T080000Z\r\n"
                                            b"DTEND:20261110T090000Z\r\nSUMMARY:Creato sul telefono\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
calsync.sync_account(acc, force=True)
check("evento creato altrove arriva (ctag cambiato)", engine.db().one("SELECT COUNT(*) n FROM events WHERE uid='esterno@prova'")["n"] == 1)
calsync.delete_event_ui({"id": out["id"]})
calsync.sync_account(acc, force=True)
check("eliminazione con DELETE", new[0] not in davserver.Dav.res and not engine.db().one("SELECT 1 FROM events WHERE id=?", (out["id"],)))
davserver.Dav.res.pop("/dav/cal/lavoro/esterno.ics")
davserver.Dav.ctag += 1
calsync.sync_account(acc, force=True)
check("evento eliminato altrove sparisce", engine.db().one("SELECT COUNT(*) n FROM events WHERE uid='esterno@prova'")["n"] == 0)

print("Inviti alle riunioni")
before = engine.db().one("SELECT COUNT(*) n FROM outbox")["n"]
inv = calsync.save_event_ui({"cal": CAL, "summary": "Riunione di cantiere 24-017", "location": "Cantiere", "start": s, "end": s + 3600,
                             "attendees": [{"a": "anna@cliente.prova.it", "n": "Anna Bianchi"}], "promemoria": 15})
ob = engine.db().one("SELECT * FROM outbox ORDER BY id DESC LIMIT 1")
raw = engine.db().get_raw(ob["blob"])
check("invito con METHOD:REQUEST ai partecipanti", engine.db().one("SELECT COUNT(*) n FROM outbox")["n"] == before + 1 and b"METHOD:REQUEST" in raw
      and b"ORGANIZER" in raw and "anna@cliente.prova.it" in ob["rcpt"])
engine.run_once(A, "ops")
anna = mailserver.BOX.users["anna@cliente.prova.it"]["folders"]["INBOX"]["msgs"]
got = [x for x in anna if b"METHOD:REQUEST" in x["raw"] and b"Riunione di cantiere" in x["raw"]]
check("invito consegnato", len(got) == 1)
evs2 = ical.events(next(p for p in __import__("email").message_from_bytes(got[0]["raw"]).walk() if p.get_content_type() == "text/calendar").get_payload(decode=True).decode())
check("invito leggibile (partecipanti, promemoria tolto dall'invito)", evs2 and evs2[0]["attendees"][0]["a"] == "anna@cliente.prova.it" and evs2[0]["organizer"]["a"] == "mario@studio.prova.it")
calsync.delete_event_ui({"id": inv["id"]})
ob = engine.db().one("SELECT * FROM outbox ORDER BY id DESC LIMIT 1")
check("annullamento (METHOD:CANCEL) ai partecipanti", ob and b"METHOD:CANCEL" in engine.db().get_raw(ob["blob"]))

print("CardDAV e rubrica")
r = calsync.handle("contacts", {}, {})
anna = next((c for c in r["items"] if c["name"] == "Anna Bianchi"), None)
check("contatto letto da CardDAV", anna and anna["emails"] == ["anna@cliente.prova.it"] and anna["org"] == "Cliente S.r.l." and anna["phones"])
check("suggerimento indirizzi dalla rubrica", any(x["fonte"] == "rubrica" and x["a"] == "anna@cliente.prova.it" for x in api.suggest_addresses("bian")["items"]))
book = next(b for b in r["rubriche"] if b["name"] == "Rubrica dello studio")["id"]
nc = calsync.handle("contact_save", {}, {"book": book, "name": "Luca Verdi", "emails": ["luca@impresa.prova.it"], "phones": ["030 123456"], "org": "Impresa Verdi"})
calsync.sync_account(acc, force=True)
vc = [h for h in davserver.Dav.res if h.startswith("/dav/card/rubrica/") and h != "/dav/card/rubrica/anna.vcf"]
check("contatto nuovo caricato", len(vc) == 1 and b"FN:Luca Verdi" in davserver.Dav.res[vc[0]][0])
calsync.handle("contact_save", {}, {"id": anna["id"], "name": "Anna Bianchi", "emails": ["anna@cliente.prova.it", "a.bianchi@pec.prova.it"],
                                    "phones": ["+39 333 1234567"], "org": "Cliente S.r.l."})
calsync.sync_account(acc, force=True)
av = davserver.Dav.res["/dav/card/rubrica/anna.vcf"][0]
check("modifica caricata, proprieta' sconosciute conservate", b"a.bianchi@pec.prova.it" in av and b"X-PROGETTO:24-017" in av)
calsync.handle("contact_delete", {}, {"id": nc["id"]})
calsync.sync_account(acc, force=True)
check("contatto eliminato anche sul server", not any(h.startswith("/dav/card/rubrica/") and h != "/dav/card/rubrica/anna.vcf" for h in davserver.Dav.res))

print("Calendario e rubrica locali (account senza CalDAV)")
B = accounts.save_account({"email": "anna@cliente.prova.it", "imap": "127.0.0.1", "imap_port": IP, "imap_sec": "none", "smtp": "127.0.0.1",
                           "smtp_port": SP, "smtp_sec": "none", "password": "prova"})["id"]
lc = calapi.local_calendar(B)
x = calsync.save_event_ui({"cal": lc, "summary": "Nota locale", "start": s, "end": s + 600})
check("evento locale (niente da caricare)", engine.db().one("SELECT dirty FROM events WHERE id=?", (x["id"],))["dirty"] == 0)
lb = calsync.book_of(B)
calsync.handle("contact_save", {}, {"book": lb, "name": "Contatto locale", "emails": ["loc@prova.it"]})
check("contatto locale", any(c["name"] == "Contatto locale" for c in calsync.handle("contacts", {}, {})["items"]))
p = calsync.Dav(acc, DAV + "/dav/")
p.auth = lambda: "Basic eHg6eXk="
try:
    calsync.discover(p)
    check("password CalDAV sbagliata riconosciuta", False)
except Exception as e:  # noqa: BLE001
    check("password CalDAV sbagliata riconosciuta", getattr(e, "auth", False), e)

print(f"\n{OK} prove riuscite, {len(FAIL)} fallite" + (": " + ", ".join(FAIL) if FAIL else ""))
_ = json
sys.exit(1 if FAIL else 0)
