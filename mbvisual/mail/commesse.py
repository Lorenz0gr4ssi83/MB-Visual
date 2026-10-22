"""Commesse: un messaggio si collega a una commessa (cartella di progetto) e si archivia li' come .eml con gli
allegati, in <cartella>/<sottocartella posta>/<data> <oggetto>/. Le PEC si archiviano con la busta firmata del
gestore (prova legale) e le ricevute di accettazione/consegna del messaggio inviato.

Riconoscimento: codice della commessa nell'oggetto, conversazione gia' collegata, indirizzi dei referenti, parole chiave.
"""
import json
import re
import secrets
import time
from datetime import datetime
from pathlib import Path

from . import engine, parse
from ..i18n import t

_BAD = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def safe(name: str, n=80) -> str:
    name = _BAD.sub("_", name or "").strip(" .")
    return name[:n].rstrip(" .") or "senza_oggetto"


def all_() -> list:
    rows = engine.db().q("SELECT * FROM commesse ORDER BY chiusa, nome")
    counts = {r["commessa"]: r["n"] for r in engine.db().q("SELECT commessa, COUNT(*) n FROM messages WHERE commessa!='' GROUP BY commessa")}
    for r in rows:
        r["parole"] = json.loads(r["parole"] or "[]")
        r["indirizzi"] = json.loads(r["indirizzi"] or "[]")
        r["messaggi"] = counts.get(r["id"], 0)
    return rows


def save(b: dict) -> dict:
    cid = b.get("id") or ("c" + secrets.token_hex(5))
    cur = engine.db().one("SELECT * FROM commesse WHERE id=?", (cid,)) or {}
    vals = {k: b.get(k, cur.get(k, "")) for k in ("nome", "codice", "cartella", "colore")}
    if not vals["nome"]:
        raise ValueError(t("srv_mail.commessa_nome_obbligatorio"))
    parole = b.get("parole", json.loads(cur.get("parole") or "[]"))
    ind = [a.strip().lower() for a in b.get("indirizzi", json.loads(cur.get("indirizzi") or "[]")) if a.strip()]
    engine.db().x("INSERT OR REPLACE INTO commesse(id, nome, codice, cartella, parole, indirizzi, colore, creata, chiusa) VALUES(?,?,?,?,?,?,?,?,?)",
                  (cid, vals["nome"], vals["codice"], vals["cartella"], json.dumps(parole), json.dumps(ind), vals["colore"],
                   cur.get("creata") or time.time(), int(b.get("chiusa", cur.get("chiusa", 0)) or 0)))
    engine.bump()
    return {"id": cid}


def delete(cid):
    engine.db().x("DELETE FROM commesse WHERE id=?", (cid,))
    engine.db().x("UPDATE messages SET commessa='' WHERE commessa=?", (cid,))
    engine.bump()


def suggest(m: dict, body: str = "") -> dict | None:
    """Commessa piu' probabile per un messaggio: {id, nome, motivo, certa}."""
    db = engine.db()
    cs = [c for c in all_() if not c["chiusa"]]
    if not cs:
        return None
    subj = (m.get("subject") or "").lower()
    # stessa conversazione gia' collegata
    if m.get("thread"):
        r = db.one("SELECT commessa FROM messages WHERE thread=? AND commessa!='' AND id!=? ORDER BY date DESC LIMIT 1", (m["thread"], m.get("id", 0)))
        if r:
            c = next((c for c in cs if c["id"] == r["commessa"]), None)
            if c:
                return {"id": c["id"], "nome": c["nome"], "motivo": "conversazione", "certa": True}
    best, score, why = None, 0, ""
    people = {m.get("from_addr", "")} | {x.get("a", "") for x in json.loads(m.get("to_json") or "[]") + json.loads(m.get("cc_json") or "[]")}
    for c in cs:
        s, w = 0, ""
        code = (c.get("codice") or "").strip().lower()
        if code and re.search(r"(?<![\w])" + re.escape(code) + r"(?![\w])", subj):
            s, w = 100, "codice"
        if set(c["indirizzi"]) & people:
            s, w = max(s, 60), w or "indirizzo"
        for p in c["parole"]:
            p = p.strip().lower()
            if p and (p in subj or p in (body or "").lower()[:20000]):
                s, w = s + (25 if p in subj else 10), w or "parola"
        if s > score:
            best, score, why = c, s, w
    if not best or score < 10:
        return None
    return {"id": best["id"], "nome": best["nome"], "motivo": why, "certa": score >= 60}


def _target(c: dict, m: dict) -> Path:
    base = Path(c["cartella"])
    if not c["cartella"] or not base.is_dir():
        raise ValueError(t("srv_mail.commessa_cartella_mancante", c["nome"]))
    sub = engine.db().setting("commesse_sottocartella", "Posta") or ""
    when = datetime.fromtimestamp(m["date"] or time.time()).strftime("%Y-%m-%d %H%M")
    folder = (base / sub if sub else base) / safe(f"{when} {m['subject'] or ''}", 90)
    return folder


def archive(ids, cid, with_atts=True) -> dict:
    """Salva i messaggi (e gli allegati) nella cartella della commessa e li collega. Restituisce le cartelle create."""
    db = engine.db()
    c = db.one("SELECT * FROM commesse WHERE id=?", (cid,))
    if not c:
        raise ValueError(t("srv_mail.commessa_inesistente"))
    out = []
    for mid in ids:
        m = db.one("SELECT * FROM messages WHERE id=?", (mid,))
        if not m:
            continue
        raw = engine.raw_of(mid)
        folder = _target(c, m)
        folder.mkdir(parents=True, exist_ok=True)
        name = safe(m["subject"] or "messaggio", 60) + ".eml"
        (folder / name).write_bytes(raw)
        saved = [name]
        if with_atts:
            saved += save_attachments(raw, folder)
        if m["pec"] == "posta-certificata" or m["pec_state"]:
            saved += _pec_extra(m, raw, folder)
        engine.set_flags([mid], commessa=cid)
        out.append({"id": mid, "cartella": str(folder), "file": saved})
    return {"ok": True, "archiviati": out}


def save_attachments(raw: bytes, folder: Path, which=None) -> list:
    r = parse.render(raw)
    saved = []
    for a in r["atts"]:
        if a.get("inline") or a.get("firma"):
            continue
        if which is not None and str(a["i"]) not in which:
            continue
        data, _, _ = parse.get_part(raw, str(a["i"]))
        p = unique(folder / safe(a["nome"], 120))
        p.write_bytes(data)
        saved.append(p.name)
    return saved


def unique(p: Path) -> Path:
    if not p.exists():
        return p
    for i in range(2, 1000):
        q = p.with_name(f"{p.stem} ({i}){p.suffix}")
        if not q.exists():
            return q
    return p


def _pec_extra(m, raw, folder: Path) -> list:
    saved = []
    msg = parse.msg_from_bytes(raw)
    info = parse.pec_info(msg)
    if info and info["dc_i"] >= 0:
        data, _, _ = parse.get_part(raw, str(info["dc_i"]))
        (folder / "daticert.xml").write_bytes(data)
        saved.append("daticert.xml")
    if m["pec_state"] and m["msgid"]:  # messaggio inviato: anche le ricevute
        rec = engine.db().q("SELECT id, pec, date FROM messages WHERE account=? AND pec_ref=? AND pec!=''", (m["account"], m["msgid"]))
        if rec:
            rf = folder / "Ricevute PEC"
            rf.mkdir(exist_ok=True)
            for r in rec:
                when = datetime.fromtimestamp(r["date"]).strftime("%Y-%m-%d %H%M%S")
                p = unique(rf / f"{when} {r['pec']}.eml")
                p.write_bytes(engine.raw_of(r["id"]))
                saved.append("Ricevute PEC/" + p.name)
    return saved
