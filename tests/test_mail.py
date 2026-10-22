"""Collaudo della posta di MB Visual con il server di prova (tests/mailserver.py), senza account veri.

    python tests/test_mail.py

Archivio in una cartella temporanea (MBV_MAIL_DIR): non tocca la posta vera dell'utente.
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="mbv-posta-prova-"))
os.environ["MBV_MAIL_DIR"] = str(TMP / "posta")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import mailserver  # noqa: E402
from mbvisual.mail import accounts, api, commesse, engine, parse, store, vault  # noqa: E402

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


def acc(email, pec=False, **kw):
    return accounts.save_account({"email": email, "nome": email.split("@")[0].title(), "tipo": "imap", "imap": "127.0.0.1", "imap_port": IP,
                                  "imap_sec": "none", "smtp": "127.0.0.1", "smtp_port": SP, "smtp_sec": "none", "utente": email,
                                  "password": "prova", "pec": pec, "scarica_giorni": 0, **kw})


def folder(aid, role):
    return engine.folder_by_role(aid, role)


def msgs(fid):
    return engine.db().q("SELECT * FROM messages WHERE folder_id=? ORDER BY date", (fid,))


print("Server di prova")
mailserver.seed()
IP, SP, _srv = mailserver.start()

print("Configurazione automatica e cassaforte")
c = accounts.autoconfig("ufficio@pec.it")
check("PEC Aruba dal dominio", c["imap"] == "imaps.pec.aruba.it" and c["smtp_port"] == 465 and c.get("pec"))
c = accounts.autoconfig("nome@legalmail.it")
check("Legalmail", c["imap"] == "mbox.cert.legalmail.it")
c = accounts.autoconfig("x@gmail.com")
check("Gmail con OAuth", c.get("oauth") == "google" and c["imap"] == "imap.gmail.com")
xml = b"""<clientConfig version="1.1"><emailProvider id="d.it"><displayName>Ditta</displayName>
<incomingServer type="imap"><hostname>imap.d.it</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username>
<authentication>password-cleartext</authentication></incomingServer><outgoingServer type="smtp"><hostname>smtp.d.it</hostname><port>587</port>
<socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></outgoingServer></emailProvider></clientConfig>"""
c = accounts._parse_autoconfig(xml, "luca@d.it")
check("autoconfig XML (Thunderbird)", c["imap"] == "imap.d.it" and c["smtp_sec"] == "starttls" and c["utente"] == "luca@d.it"
      and c["utente_smtp"] == "luca")
blob = vault.seal(b"segreto di prova", b"x")
check("AES-GCM con chiave DPAPI", vault.open_(blob, b"x") == b"segreto di prova" and b"segreto" not in blob)

A = acc("mario@studio.prova.it")["id"]
P = acc("studio@pec.prova.it", pec=True)["id"]
C = acc("comune@pec.prova.it", pec=True)["id"]
N = acc("anna@cliente.prova.it")["id"]
check("password non in chiaro su disco", b"prova" not in accounts.SEC_FILE.read_bytes() and "prova\"" not in accounts.ACC_FILE.read_text("utf-8"))
check("prova account (IMAP+SMTP)", api.test_account({**accounts.get(A), "password": "prova"}, lambda *a: None) ["imap"]["ok"])
bad = api.test_account({**accounts.get(A), "password": "sbagliata", "id": None}, lambda *a: None)
check("password sbagliata riconosciuta", not bad["imap"]["ok"] and bad["imap"]["auth"])

print("Sincronizzazione")
st = engine.run_once(A)
check("sincronizzazione riuscita", st.get("stato") == "ok", st)
inbox = folder(A, "inbox")
sent = folder(A, "sent")
check("ruoli delle cartelle (SPECIAL-USE)", inbox and sent and folder(A, "trash") and folder(A, "drafts") and folder(A, "junk"))
rows = msgs(inbox["id"])
check("messaggi della INBOX", len(rows) == 33, len(rows))
check("corpi scaricati per la lettura senza rete", all(r["blob"] for r in rows))
first = next(r for r in rows if r["subject"].startswith("Commessa 24-017"))
check("allegati riconosciuti", first["has_att"] == 1 and len(json.loads(first["att_json"])) >= 1, first["att_json"])
th = engine.db().q("SELECT * FROM messages WHERE thread=?", (first["thread"],))
check("conversazione (3 messaggi, anche dalla Inviata)", len(th) == 3, len(th))
lst = api.list_messages({"folder": inbox["id"], "conversazioni": True})
conv = next(x for x in lst["items"] if x["thread"] == first["thread"])
check("elenco a conversazioni", conv["conv_n"] == 3 and lst["totale"] == 32, (conv["conv_n"], lst["totale"]))
check("priorita' alta", engine.db().one("SELECT COUNT(*) n FROM messages WHERE priority=1")["n"] == 1)
check("invito riconosciuto", engine.db().one("SELECT COUNT(*) n FROM messages WHERE invite=1")["n"] == 1)

print("Ricerca")
r = api.list_messages({"folder": "tutto", "q": "acciaio"})
check("testo nel corpo", r["totale"] == 30, r["totale"])
r = api.list_messages({"folder": "tutto", "q": "da:anna capannone"})
check("operatore da: + parola", r["totale"] == 2, r["totale"])
r = api.list_messages({"folder": "tutto", "q": "ha:allegato"})
check("ha:allegato", r["totale"] >= 1)
r = api.list_messages({"folder": "tutto", "q": "is:unread offert"})
check("non letti + prefisso", r["totale"] == 5, r["totale"])
r = api.list_messages({"folder": "tutto", "q": "capann*"})
check("ricerca senza accenti/prefisso", r["totale"] >= 2)

print("Lettura")
m = api.message({"id": first["id"]})
check("intestazioni e HTML", m["h"]["from"][0]["a"] == "anna@cliente.prova.it" and "tavola aggiornata" in m["html"])
pdf = next((a for a in m["atts"] if a["nome"].endswith(".pdf")), None)
if pdf:
    data, hdr = api.part({"id": first["id"], "i": pdf["i"]})
    check("allegato PDF estratto", data[:4] == b"%PDF")
    f = api.att_file({"id": first["id"], "i": pdf["i"]})
    check("allegato in file temporaneo per aprirlo in MB Visual", Path(f["path"]).read_bytes()[:4] == b"%PDF")
inv = next(r for r in rows if r["invite"])
m2 = api.message({"id": inv["id"]})
check("invito: testo iCalendar", m2["inviti"] and "Sopralluogo" in m2["inviti"][0]["ics"])

from mbvisual.mail import calapi  # noqa: E402
calapi.cal_reply({"id": inv["id"], "i": m2["inviti"][0]["i"], "risposta": "ACCEPTED"})
ob = engine.db().one("SELECT * FROM outbox ORDER BY id DESC LIMIT 1")
rr = engine.db().get_raw(ob["blob"])
check("invito accettato: REPLY all'organizzatore", b"METHOD:REPLY" in rr and b"PARTSTAT=ACCEPTED" in rr and "anna@cliente.prova.it" in ob["rcpt"])
ev = engine.db().one("SELECT * FROM events WHERE uid='riunione-24017@prova.it'")
check("evento nel calendario", ev and ev["summary"] == "Sopralluogo cantiere 24-017" and ev["end"] - ev["start"] == 3600)
engine.run_once(A, "ops")
check("risposta all'invito consegnata", any(b"METHOD:REPLY" in x["raw"] for x in mailserver.BOX.users["anna@cliente.prova.it"]["folders"]["INBOX"]["msgs"]))

print("Stati e operazioni (anche sul server)")
engine.set_flags([first["id"]], seen=1, flagged=1, categories=["Rosso"])
engine.run_once(A, "ops")
srv = mailserver.BOX.users["mario@studio.prova.it"]["folders"]["INBOX"]["msgs"]
sm = next(x for x in srv if b"Commessa 24-017 - Ampliamento" in x["raw"][:2000] and b"In-Reply-To" not in x["raw"][:2000])
check("letto e contrassegnato sul server", {"\\Seen", "\\Flagged"} <= sm["flags"], sm["flags"])
offers = [r["id"] for r in rows if r["subject"].startswith("Offerta")][:3]
engine.move(offers, folder(A, "archive")["id"])
engine.run_once(A, "sync")
arch = msgs(folder(A, "archive")["id"])
check("spostamento in Archivio (MOVE con COPYUID)", len(arch) == 3 and all(r["uid"] > 0 for r in arch), [(r["uid"]) for r in arch])
check("niente doppioni dopo la sincronizzazione", len(msgs(inbox["id"])) == 30)
engine.delete([arch[0]["id"]])
engine.run_once(A, "sync")
check("eliminato -> Cestino", len(msgs(folder(A, "trash")["id"])) == 1)
engine.delete([msgs(folder(A, "trash")["id"])[0]["id"]])
engine.run_once(A, "sync")
check("eliminazione definitiva dal Cestino", len(msgs(folder(A, "trash")["id"])) == 0
      and not mailserver.BOX.users["mario@studio.prova.it"]["folders"]["Cestino"]["msgs"])

print("Invio, risposta, bozze, invio programmato")
prep = api.compose_prep({"mode": "reply", "id": first["id"]})["c"]
check("risposta: destinatario e oggetto", prep["to"][0]["a"] == "anna@cliente.prova.it" and prep["subject"].startswith("R:"), prep["subject"])
prep.update(html="<p>Ricevuto, grazie.</p>" + prep["quote"], account=A)
api.send({"c": prep})
engine.run_once(A, "ops")
anna_in = mailserver.BOX.users["anna@cliente.prova.it"]["folders"]["INBOX"]["msgs"]
check("consegnato al destinatario", any(b"Ricevuto, grazie" in x["raw"] for x in anna_in))
srv_sent = mailserver.BOX.users["mario@studio.prova.it"]["folders"]["Inviata"]["msgs"]
check("copia in Inviata sul server (APPEND)", any(b"Ricevuto, grazie" in x["raw"] for x in srv_sent))
check("messaggio originale segnato come risposto", engine.db().one("SELECT answered FROM messages WHERE id=?", (first["id"],))["answered"] == 1)
check("risposta nella stessa conversazione", engine.db().one("SELECT COUNT(*) n FROM messages WHERE thread=?", (first["thread"],))["n"] == 4)
bcc = {"account": A, "to": [{"n": "", "a": "anna@cliente.prova.it"}], "bcc": [{"n": "", "a": "rifiutato@x.it"}], "subject": "Ccn", "html": "<p>x</p>"}
raw, info = __import__("mbvisual.mail.compose", fromlist=["x"]).build(bcc, accounts.get(A))
from mbvisual.mail.compose import strip_bcc  # noqa: E402
check("Ccn tolto dal messaggio trasmesso", b"Bcc:" in raw and b"Bcc:" not in strip_bcc(raw) and "rifiutato@x.it" in info["rcpt"])
d = api.save_draft({"c": {"account": A, "to": [{"n": "", "a": "anna@cliente.prova.it"}], "subject": "Bozza di prova", "html": "<p>da finire</p>"}})
engine.run_once(A, "ops")
check("bozza salvata e caricata nelle Bozze del server",
      any(b"Bozza di prova" in x["raw"] for x in mailserver.BOX.users["mario@studio.prova.it"]["folders"]["Bozze"]["msgs"]))
d2 = api.save_draft({"c": {"account": A, "to": [], "subject": "Bozza di prova 2", "html": "<p>x</p>", "draft_id": d["draft_id"]}})
engine.run_once(A, "ops")
bz = mailserver.BOX.users["mario@studio.prova.it"]["folders"]["Bozze"]["msgs"]
check("bozza aggiornata sostituisce la precedente", len(bz) == 1 and b"Bozza di prova 2" in bz[0]["raw"], len(bz))
later = api.send({"c": {"account": A, "to": [{"n": "", "a": "anna@cliente.prova.it"}], "subject": "Programmato", "html": "<p>dopo</p>"},
                  "send_at": time.time() + 3600})
engine.run_once(A, "ops")
check("invio programmato resta in uscita", engine.db().one("SELECT COUNT(*) n FROM outbox")["n"] == 1
      and not any(b"Programmato" in x["raw"] for x in mailserver.BOX.users["anna@cliente.prova.it"]["folders"]["INBOX"]["msgs"]))
api.outbox_op({"id": later["outbox"], "azione": "invia_ora"})
engine.run_once(A, "ops")
check("'Invia ora' lo spedisce", engine.db().one("SELECT COUNT(*) n FROM outbox")["n"] == 0
      and any(b"Programmato" in x["raw"] for x in mailserver.BOX.users["anna@cliente.prova.it"]["folders"]["INBOX"]["msgs"]))
check("indirizzi suggeriti dalla posta", any(x["a"] == "anna@cliente.prova.it" for x in api.suggest_addresses("ann")["items"]))

print("PEC")
engine.run_once(P)
pin = msgs(folder(P, "inbox")["id"])
pc = next(r for r in pin if r["pec"] == "posta-certificata")
check("busta PEC: mittente e oggetto originali", pc["from_addr"] == "comune@pec.prova.it" and pc["subject"].startswith("Richiesta integrazioni"), (pc["from_addr"], pc["subject"]))
mm = api.message({"id": pc["id"]})
check("postacert.eml aperto direttamente", mm["h"]["subject"].startswith("Richiesta integrazioni") and any(a["nome"].endswith(".pdf") for a in mm["atts"]))
check("daticert.xml letto", mm["pec"]["daticert"]["gestore"] == mailserver.pecsim.GESTORE and mm["pec"]["daticert"]["mittente"] == "comune@pec.prova.it")
check("busta: daticert, postacert e firma elencati", {x["nome"] for x in mm["pec"]["busta"]} == {"daticert.xml", "postacert.eml", "smime.p7s"})
rp = api.compose_prep({"mode": "reply", "id": pc["id"]})["c"]
check("risposta a una PEC va al mittente vero", rp["to"][0]["a"] == "comune@pec.prova.it")
r = api.send({"c": {"account": P, "to": [{"n": "", "a": "comune@pec.prova.it"}, {"n": "", "a": "nessuno@pec.prova.it"}],
                    "subject": "Trasmissione integrazioni SCIA 2026/123", "html": "<p>In allegato le integrazioni.</p>"}})
engine.run_once(P, "ops")
engine.run_once(P, "sync")
sp = next(x for x in msgs(folder(P, "sent")["id"]) if x["subject"].startswith("Trasmissione"))
stt = engine.pec_status(P, sp["msgid"])
check("ricevuta di accettazione collegata", stt["accettazione"] is not None)
check("consegna e mancata consegna per destinatario", {d["a"]: d["stato"] for d in stt["destinatari"]} ==
      {"comune@pec.prova.it": "consegnata", "nessuno@pec.prova.it": "errore"}, stt["destinatari"])
check("stato complessivo 'parziale-errore'", sp["pec_state"] == "parziale-errore", sp["pec_state"])
check("ricevute nascoste dalla INBOX", all(x["pec"] not in engine.RECEIPTS for x in api.list_messages({"folder": folder(P, "inbox")["id"]})["items"]))
check("archivio delle ricevute", api.list_messages({"folder": "ricevute"})["totale"] == 3)
r2 = api.send({"c": {"account": P, "to": [{"n": "", "a": "comune@pec.prova.it"}], "subject": "Seconda trasmissione", "html": "<p>ok</p>"}})
engine.run_once(P, "ops")
engine.run_once(P, "sync")
s2 = next(x for x in msgs(folder(P, "sent")["id"]) if x["subject"] == "Seconda trasmissione")
check("PEC consegnata", s2["pec_state"] == "consegnata", s2["pec_state"])
api.send({"c": {"account": P, "to": [{"n": "", "a": "comune@pec.prova.it"}], "subject": "[rifiuta] prova", "html": "<p>x</p>"}})
engine.run_once(P, "ops")
engine.run_once(P, "sync")
s3 = next(x for x in msgs(folder(P, "sent")["id"]) if x["subject"] == "[rifiuta] prova")
check("non accettazione", s3["pec_state"] == "non-accettata", s3["pec_state"])
rec = next(x for x in msgs(folder(P, "inbox")["id"]) if x["pec"] == "avvenuta-consegna")
mr = api.message({"id": rec["id"]})
check("ricevuta -> messaggio originale", mr.get("pec_originale") and mr["pec_originale"]["id"] in (sp["id"], s2["id"]))
engine.run_once(C)
check("il destinatario PEC riceve la busta", any(x["pec"] == "posta-certificata" and x["subject"].startswith("Trasmissione")
                                                 for x in msgs(folder(C, "inbox")["id"])))

print("Commesse e regole")
cdir = TMP / "Commessa 24-017"
cdir.mkdir()
cid = commesse.save({"nome": "Ampliamento capannone", "codice": "24-017", "cartella": str(cdir), "indirizzi": ["anna@cliente.prova.it"]})["id"]
sug = commesse.suggest(engine.db().one("SELECT * FROM messages WHERE id=?", (first["id"],)))
check("commessa riconosciuta dal codice", sug and sug["id"] == cid and sug["certa"])
res = commesse.archive([first["id"]], cid)
out = Path(res["archiviati"][0]["cartella"])
check("archiviato .eml + allegati nella cartella", any(p.suffix == ".eml" for p in out.iterdir()) and any(p.suffix == ".pdf" for p in out.iterdir()),
      [p.name for p in out.iterdir()])
check("vista posta per commessa", api.list_messages({"folder": "commessa:" + cid})["totale"] == 1)
cid2 = commesse.save({"nome": "Pratica SCIA", "codice": "2026/123", "cartella": str(TMP)})["id"]
res = commesse.archive([sp["id"]], cid2)
fl = res["archiviati"][0]["file"]
check("PEC inviata archiviata con le ricevute", sum(1 for f in fl if f.startswith("Ricevute PEC/")) == 3, fl)
res = commesse.archive([pc["id"]], cid2)
check("PEC ricevuta archiviata con daticert.xml", "daticert.xml" in res["archiviati"][0]["file"])
api.handle("rule_save", {}, {"nome": "Fornitori", "cond": {"da": "fornitore.prova.it"}, "azioni": {"categoria": "Blu", "letto": True}})
mailserver.BOX.deliver("mario@studio.prova.it", b"From: Nuovo <x@fornitore.prova.it>\r\nTo: mario@studio.prova.it\r\nSubject: Listino 24-017\r\n"
                                               b"Message-ID: <listino@prova.it>\r\nDate: Mon, 19 Oct 2026 10:00:00 +0200\r\n\r\nListino aggiornato.\r\n")
engine.run_once(A, "sync")
nr = engine.db().one("SELECT * FROM messages WHERE msgid='<listino@prova.it>'")
check("regola applicata ai nuovi messaggi", nr and nr["seen"] == 1 and "Blu" in nr["categories"], nr and (nr["seen"], nr["categories"]))
check("commessa collegata in automatico (codice nell'oggetto)", nr["commessa"] == cid)

print("Archivio cifrato e lettura senza rete")
engine.db().flush()
idx = store.DB_FILE.read_bytes()
check("indice cifrato (niente testo leggibile)", b"Ampliamento" not in idx and b"anna@cliente" not in idx and idx[:4] == b"MBV1")
anyblob = next(store.MSG_DIR.rglob("*.bin")).read_bytes()
check("messaggi cifrati", b"From:" not in anyblob)
s2_ = store.Store()
check("indice riaperto da disco", s2_.one("SELECT COUNT(*) n FROM messages")["n"] == engine.db().one("SELECT COUNT(*) n FROM messages")["n"])
_srv[0].shutdown()
_srv[1].shutdown()
_srv[0].server_close()
_srv[1].server_close()
m = api.message({"id": first["id"]})
check("lettura senza rete", "tavola aggiornata" in m["html"])
st = engine.run_once(A, "sync")
check("senza rete: stato 'offline', nessun errore grave", st.get("stato") == "offline", st)
api.send({"c": {"account": A, "to": [{"n": "", "a": "anna@cliente.prova.it"}], "subject": "Scritto senza rete", "html": "<p>x</p>"}})
engine.run_once(A, "ops")
check("senza rete il messaggio resta in uscita", engine.db().one("SELECT status FROM outbox")["status"] == "attesa")
IP2, SP2, _srv2 = mailserver.start(IP, SP)
engine.run_once(A, "ops")
check("al ritorno della rete parte", engine.db().one("SELECT COUNT(*) n FROM outbox")["n"] == 0
      and any(b"Scritto senza rete" in x["raw"] for x in mailserver.BOX.users["anna@cliente.prova.it"]["folders"]["INBOX"]["msgs"]))

print(f"\n{OK} prove riuscite, {len(FAIL)} fallite" + (": " + ", ".join(FAIL) if FAIL else ""))
sys.exit(1 if FAIL else 0)
