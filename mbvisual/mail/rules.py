"""Regole sui messaggi in arrivo (come le regole di Outlook) e riconoscimento automatico della commessa.

Condizioni (tutte quelle indicate devono valere): da, a (destinatari), oggetto, corpo (testo contenuto, piu' parole
separate da ";" = una qualsiasi), allegati (true), pec ("ricevute" | "posta-certificata" | "tutte"), priorita' alta.
Azioni: sposta (id cartella), letto, contrassegna, categoria, commessa (collega), archivia (salva .eml e allegati
nella cartella della commessa), elimina. "stop" = non applicare le regole successive.
"""
import json

from . import engine


def _has(text, needle) -> bool:
    text = (text or "").lower()
    return any(n.strip() and n.strip().lower() in text for n in str(needle).split(";"))


def matches(cond: dict, m: dict, body: str = "") -> bool:
    if cond.get("da") and not _has(f"{m['from_name']} {m['from_addr']}", cond["da"]):
        return False
    if cond.get("a"):
        people = " ".join(f"{x.get('n', '')} {x.get('a', '')}" for x in json.loads(m["to_json"]) + json.loads(m["cc_json"]))
        if not _has(people, cond["a"]):
            return False
    if cond.get("oggetto") and not _has(m["subject"], cond["oggetto"]):
        return False
    if cond.get("corpo") and not _has(body or m["preview"], cond["corpo"]):
        return False
    if cond.get("allegati") and not m["has_att"]:
        return False
    if cond.get("priorita") and m["priority"] != 1:
        return False
    p = cond.get("pec")
    if p == "ricevute" and m["pec"] not in engine.RECEIPTS:
        return False
    if p == "posta-certificata" and m["pec"] != "posta-certificata":
        return False
    if p == "tutte" and not m["pec"]:
        return False
    return True


def _body(mid) -> str:
    r = engine.db().one("SELECT body FROM fts WHERE rowid=?", (mid,))
    return r["body"] if r else ""


def apply_new(acc, ids, rules=None):
    db = engine.db()
    rules = rules if rules is not None else db.q("SELECT * FROM rules WHERE attiva=1 AND (account='*' OR account=?) ORDER BY ord, id", (acc["id"],))
    auto = db.setting("commesse_auto", True)
    done = 0
    for mid in ids:
        m = db.one("SELECT * FROM messages WHERE id=?", (mid,))
        if not m:
            continue
        body = _body(mid)
        for r in rules:
            if not matches(json.loads(r["cond"] or "{}"), m, body):
                continue
            done += 1
            a = json.loads(r["azioni"] or "{}")
            if a.get("letto"):
                engine.set_flags([mid], seen=1)
            if a.get("contrassegna"):
                engine.set_flags([mid], flagged=1)
            if a.get("categoria"):
                cats = json.loads(m["categories"] or "[]")
                if a["categoria"] not in cats:
                    engine.set_flags([mid], categories=cats + [a["categoria"]])
            if a.get("commessa"):
                engine.set_flags([mid], commessa=a["commessa"])
                if a.get("archivia"):
                    from . import commesse
                    try:
                        commesse.archive([mid], a["commessa"])
                    except Exception:  # noqa: BLE001
                        pass
            if a.get("elimina"):
                engine.delete([mid])
                break
            if a.get("sposta"):
                engine.move([mid], int(a["sposta"]))
            if r["stop"]:
                break
        if auto:
            m = db.one("SELECT * FROM messages WHERE id=?", (mid,))
            if m and not m["commessa"]:
                from . import commesse
                c = commesse.suggest(m, body)
                if c and c.get("certa"):
                    engine.set_flags([mid], commessa=c["id"])
    return done


def run_on_folder(rule_id, folder_id):
    db = engine.db()
    r = db.one("SELECT * FROM rules WHERE id=?", (rule_id,))
    f = db.one("SELECT * FROM folders WHERE id=?", (folder_id,))
    if not r or not f:
        return 0
    from . import accounts
    ids = [x["id"] for x in db.q("SELECT id FROM messages WHERE folder_id=?", (folder_id,))]
    return apply_new(accounts.get(f["account"]), ids, rules=[r])
