"""Microsoft 365 / Outlook.com con Microsoft Graph (stesso ruolo di ImapProvider in engine.py).

- Cartelle: /me/mailFolders (+ childFolders), ruoli dalle cartelle note (inbox, sentitems, drafts, deleteditems,
  junkemail, archive). Percorso = nomi visualizzati uniti da "/"; folders.remote_id = id di Graph.
- Messaggi: query delta per cartella (folders.delta = deltaLink): nuovi, cambiati (letto, bandierina, categorie) e tolti.
  L'elenco si costruisce dal JSON (intestazioni sintetiche); il messaggio completo e' il MIME di /messages/{id}/$value,
  scaricato in background per la lettura senza rete o all'apertura.
- Invio: /me/sendMail con il MIME in base64 (fino a ~3,5 MB); oltre, bozza JSON + allegati a blocchi (upload session)
  + /send. Graph salva da solo in Posta inviata.
"""
import base64
import json
import time
from email.utils import formataddr, format_datetime
from datetime import datetime

from .. import cloud
from ..i18n import t
from . import engine, parse
from .imapc import MailError

WELL_KNOWN = {"inbox": "inbox", "sentitems": "sent", "drafts": "drafts", "deleteditems": "trash", "junkemail": "junk", "archive": "archive"}
SELECT = ("id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,flag,hasAttachments,internetMessageId,"
          "conversationId,bodyPreview,categories,importance,parentFolderId,isDraft")
MIME_LIMIT = 3_500_000


class GraphProvider:
    API = "https://graph.microsoft.com/v1.0"

    def __init__(self, acc):
        self.acc = acc

    def close(self):
        pass

    # ---------------------------------------------------------- HTTP
    def _token(self):
        from . import oauth
        return oauth.access_token(self.acc)

    def call(self, method, path, js=None, data=None, headers=None, ok=(200, 201, 202, 204), raw=False):
        url = path if path.startswith("http") else self.API + path
        h = {"Authorization": "Bearer " + self._token(), "Accept": "application/json", **(headers or {})}
        body = data
        if js is not None:
            body = json.dumps(js).encode("utf-8")
            h["Content-Type"] = "application/json"
        for attempt in range(4):
            try:
                st, hd, b = cloud._http(method, url, h, body, timeout=120)
            except cloud.CloudError as e:
                raise MailError(str(e), offline=True) from e
            if st in (429, 503, 504) and attempt < 3:
                try:
                    wait = int(hd.get("Retry-After") or 2)
                except (TypeError, ValueError):
                    wait = 2
                time.sleep(min(wait, 30))
                continue
            break
        if raw:
            return st, b
        if st == 401:
            raise MailError(t("srv_mail.oauth_accedi_di_nuovo", self.acc.get("email", "")), auth=True)
        if st not in ok:
            raise MailError("Microsoft Graph: " + (cloud._err_text(b) or str(st)))
        return cloud._jsonb(b) if b and b[:1] in (b"{", b"[") else b

    def pages(self, path, limit=100000):
        out, url = [], path
        while url and len(out) < limit:
            j = self.call("GET", url)
            out += j.get("value", [])
            url = j.get("@odata.nextLink")
        return out

    def test(self):
        me = self.call("GET", "/me")
        inbox = self.call("GET", "/me/mailFolders/inbox")
        return {"ok": True, "account": me.get("mail") or me.get("userPrincipalName"), "da_leggere": inbox.get("unreadItemCount", 0)}

    # ---------------------------------------------------------- sincronizzazione
    def _folders(self):
        roles = {}
        for wk, role in WELL_KNOWN.items():
            st, b = self.call("GET", f"/me/mailFolders/{wk}?$select=id", raw=True)
            if st == 200:
                roles[cloud._jsonb(b)["id"]] = role
        out = []

        def walk(items, prefix):
            for f in items:
                path = (prefix + "/" if prefix else "") + f["displayName"]
                out.append({"id": f["id"], "path": path, "name": f["displayName"], "role": roles.get(f["id"], "")})
                if f.get("childFolderCount"):
                    walk(self.pages(f"/me/mailFolders/{f['id']}/childFolders?$top=250"), path)
        walk(self.pages("/me/mailFolders?$top=250"), "")
        return out

    def sync(self, progress=None, only=None):
        aid = self.acc["id"]
        db = engine.db()
        remote = self._folders()
        ids = set()
        for f in remote:
            fid = engine.ensure_folder(aid, f["path"], f["name"], f["role"], "/", 0, f["id"])
            db.x("UPDATE folders SET remote_id=? WHERE id=?", (f["id"], fid))
            ids.add(f["id"])
        for f in db.q("SELECT id, remote_id FROM folders WHERE account=? AND remote_id!=''", (aid,)):
            if f["remote_id"] not in ids:
                for m in db.q("SELECT id FROM messages WHERE folder_id=?", (f["id"],)):
                    engine.remove_message(m["id"])
                db.x("DELETE FROM folders WHERE id=?", (f["id"],))
        folders = db.q("SELECT * FROM folders WHERE account=? AND remote_id!='' ORDER BY CASE role WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END", (aid,))
        for i, f in enumerate(folders):
            if only and f["id"] not in only:
                continue
            if progress:
                progress(f"{f['name']} ({i + 1}/{len(folders)})")
            self.sync_folder(f)
        for f in folders:
            self.fetch_bodies(f)

    def sync_folder(self, f):
        aid, db = self.acc["id"], engine.db()
        first = not f["synced"]
        url = f["delta"] or f"/me/mailFolders/{f['remote_id']}/messages/delta?$select={SELECT}"
        new_inbox = []
        while url:
            st, b = self.call("GET", url, headers={"Prefer": "odata.maxpagesize=100"}, raw=True)
            if st == 410 or (st == 400 and f["delta"]):  # deltaLink scaduto: si riparte da capo
                db.x("UPDATE folders SET delta='' WHERE id=?", (f["id"],))
                url, f = f"/me/mailFolders/{f['remote_id']}/messages/delta?$select={SELECT}", {**f, "delta": ""}
                continue
            if st == 401:
                raise MailError(t("srv_mail.oauth_accedi_di_nuovo", self.acc.get("email", "")), auth=True)
            if st != 200:
                raise MailError("Microsoft Graph: " + (cloud._err_text(b) or str(st)))
            j = cloud._jsonb(b)
            for m in j.get("value", []):
                mid = self._apply_item(f, m)
                if mid and f["role"] == "inbox" and not first:
                    new_inbox.append(mid)
            url = j.get("@odata.nextLink")
            if j.get("@odata.deltaLink"):
                db.x("UPDATE folders SET delta=?, synced=? WHERE id=?", (j["@odata.deltaLink"], time.time(), f["id"]))
        if new_inbox:
            self.fetch_bodies(f, ids=new_inbox)
            from . import rules
            rules.apply_new(self.acc, new_inbox)
            for mid in new_inbox:
                r = db.one("SELECT id, subject, from_name, from_addr, seen, pec FROM messages WHERE id=?", (mid,))
                if r and not r["seen"]:
                    engine._NEW.append({**r, "account": aid})

    def _apply_item(self, f, m):
        db = engine.db()
        aid = self.acc["id"]
        row = db.one("SELECT id, folder_id FROM messages WHERE account=? AND remote_id=?", (aid, m["id"]))
        if "@removed" in m:
            if row and row["folder_id"] == f["id"]:
                engine.remove_message(row["id"])
            return None
        flag = (m.get("flag") or {}).get("flagStatus", "notFlagged")
        vals = {"seen": int(bool(m.get("isRead"))), "flagged": int(flag in ("flagged", "complete")), "flag_done": int(flag == "complete"),
                "categories": json.dumps(m.get("categories") or [])}
        if row:
            if row["folder_id"] != f["id"]:
                db.x("UPDATE messages SET folder_id=? WHERE id=?", (f["id"], row["id"]))
            if not engine._pending_flag(aid, row["id"]):
                db.x("UPDATE messages SET seen=?, flagged=?, flag_done=?, categories=? WHERE id=?", (*vals.values(), row["id"]))
            engine.bump()
            return None
        raw = synthetic(m)
        mid = engine.add_message(aid, f["id"], raw, remote_id=m["id"], flags=(), full=False)
        db.x("UPDATE messages SET seen=?, flagged=?, flag_done=?, categories=?, has_att=?, preview=?, draft=? WHERE id=?",
             (*vals.values(), int(bool(m.get("hasAttachments"))), (m.get("bodyPreview") or "")[:220], int(bool(m.get("isDraft"))), mid))
        return mid

    def fetch_bodies(self, f, ids=None):
        days = int(self.acc.get("scarica_giorni") or 0)
        since = time.time() - days * 86400 if days > 0 else 0
        db = engine.db()
        if ids:
            rows = db.q("SELECT id, remote_id FROM messages WHERE id IN (%s) AND blob=''" % ",".join("?" * len(ids)), ids)
        else:
            rows = db.q("SELECT id, remote_id FROM messages WHERE folder_id=? AND blob='' AND remote_id!='' AND date>=? ORDER BY date DESC LIMIT 2000",
                        (f["id"], since))
        for i, r in enumerate(rows):
            raw = self.fetch_raw(r)
            if raw:
                engine.fill_body(r["id"], raw)
            if i % 20 == 0:
                engine.set_status(self.acc["id"], avanzamento=t("srv_mail.scaricati_n", f["name"], i, len(rows)))
        engine.set_status(self.acc["id"], avanzamento="")

    def fetch_raw(self, row):
        st, b = self.call("GET", f"/me/messages/{row['remote_id']}/$value", raw=True)
        if st == 200 and b:
            return b
        if st in (401, 403):
            raise MailError(t("srv_mail.oauth_accedi_di_nuovo", self.acc.get("email", "")), auth=True)
        return None

    # ---------------------------------------------------------- operazioni
    def apply(self, op, args):
        db = engine.db()
        if op == "flags":
            for r in db.q("SELECT id, remote_id, categories FROM messages WHERE id IN (%s) AND remote_id!=''" % ",".join("?" * len(args["ids"])), args["ids"]):
                body = {}
                if "seen" in args:
                    body["isRead"] = bool(args["seen"])
                if "flagged" in args:
                    body["flag"] = {"flagStatus": "flagged" if args["flagged"] else "notFlagged"}
                if body:
                    self.call("PATCH", f"/me/messages/{r['remote_id']}", js=body)
        elif op == "local":  # categorie e completamento (campi che in Graph esistono)
            for r in db.q("SELECT remote_id, categories, flagged, flag_done FROM messages WHERE id IN (%s) AND remote_id!=''" % ",".join("?" * len(args["ids"])), args["ids"]):
                body = {"categories": json.loads(r["categories"] or "[]")}
                if r["flag_done"]:
                    body["flag"] = {"flagStatus": "complete"}
                self.call("PATCH", f"/me/messages/{r['remote_id']}", js=body)
        elif op == "move":
            dest = db.one("SELECT remote_id FROM folders WHERE id=?", (args["dest"],))
            rows = db.q("SELECT id, remote_id FROM messages WHERE id IN (%s)" % ",".join("?" * len(args.get("ids") or [0])), args.get("ids") or [0])
            for r in rows:
                if not r["remote_id"]:
                    continue
                st, b = self.call("POST", f"/me/messages/{r['remote_id']}/move", js={"destinationId": dest["remote_id"]}, raw=True)
                if st in (200, 201):
                    db.x("UPDATE messages SET remote_id=? WHERE id=?", (cloud._jsonb(b)["id"], r["id"]))
                elif st != 404:
                    raise MailError("Microsoft Graph: " + (cloud._err_text(b) or str(st)))
        elif op == "expunge":
            for rid in args.get("remote_ids") or []:
                st, b = self.call("DELETE", f"/me/messages/{rid}", raw=True)
                if st not in (204, 404):
                    raise MailError("Microsoft Graph: " + (cloud._err_text(b) or str(st)))
        elif op == "draft":
            raw = db.get_raw(db.one("SELECT blob FROM messages WHERE id=?", (args["mid"],))["blob"])
            if args.get("old_remote"):
                self.call("DELETE", f"/me/messages/{args['old_remote']}", ok=(204, 404))
            j = self.call("POST", "/me/messages", data=base64.b64encode(raw), headers={"Content-Type": "text/plain"})
            db.x("UPDATE messages SET remote_id=? WHERE id=?", (j["id"], args["mid"]))
        elif op == "append":  # copia da un altro account o .eml importato: messaggio MIME nella cartella
            f = db.one("SELECT remote_id FROM folders WHERE id=?", (args["folder"],))
            raw = db.get_raw(args["blob"])
            j = self.call("POST", "/me/messages", data=base64.b64encode(raw), headers={"Content-Type": "text/plain"})
            j2 = self.call("POST", f"/me/messages/{j['id']}/move", js={"destinationId": f["remote_id"]})
            self.call("PATCH", f"/me/messages/{j2['id']}", js={"isRead": True})
            if args.get("mid"):
                db.x("UPDATE messages SET remote_id=? WHERE id=?", (j2["id"], args["mid"]))
        elif op == "folder_create":
            parent = args["path"].rsplit("/", 1)
            name = parent[-1]
            pf = db.one("SELECT remote_id FROM folders WHERE account=? AND path=?", (self.acc["id"], parent[0])) if len(parent) > 1 else None
            url = f"/me/mailFolders/{pf['remote_id']}/childFolders" if pf and pf["remote_id"] else "/me/mailFolders"
            self.call("POST", url, js={"displayName": name})
        elif op == "folder_delete":
            if args.get("remote_id"):
                self.call("DELETE", f"/me/mailFolders/{args['remote_id']}", ok=(204, 404))
        elif op == "folder_rename":
            if args.get("remote_id"):
                self.call("PATCH", f"/me/mailFolders/{args['remote_id']}", js={"displayName": args["name"]})

    def send(self, raw, sender, rcpt):
        b64 = base64.b64encode(raw)
        if len(b64) <= MIME_LIMIT:
            self.call("POST", "/me/sendMail", data=b64, headers={"Content-Type": "text/plain"})
            return {"ora": time.time()}
        return self._send_large(raw)

    def _send_large(self, raw):
        """Messaggio oltre i 4 MB di Graph: bozza JSON, allegati con upload session, poi invio."""
        msg = parse.msg_from_bytes(raw)
        r = parse.render(raw)
        recip = lambda hdr: [{"emailAddress": {"address": x["a"], "name": x["n"]}} for x in parse.addrs(msg.get_all(hdr) or [])]  # noqa: E731
        body = {"subject": r["h"]["subject"], "body": {"contentType": "HTML" if r["html"] else "Text", "content": r["html"] or r["text"]},
                "toRecipients": recip("To"), "ccRecipients": recip("Cc"), "bccRecipients": recip("Bcc"),
                "internetMessageId": r["h"]["msgid"] or None, "importance": "high" if r["h"]["priority"] == 1 else "normal"}
        d = self.call("POST", "/me/messages", js={k: v for k, v in body.items() if v is not None})
        for a in r["atts"]:
            data, ctype, name = parse.get_part(raw, str(a["i"]))
            if len(data) < 3_000_000:
                self.call("POST", f"/me/messages/{d['id']}/attachments", js={"@odata.type": "#microsoft.graph.fileAttachment", "name": name or a["nome"],
                                                                             "contentType": ctype, "contentBytes": base64.b64encode(data).decode(),
                                                                             "isInline": bool(a.get("inline")), "contentId": a.get("cid") or None})
                continue
            s = self.call("POST", f"/me/messages/{d['id']}/attachments/createUploadSession",
                          js={"AttachmentItem": {"attachmentType": "file", "name": name or a["nome"], "size": len(data), "contentType": ctype}})
            pos, chunk = 0, 320 * 1024 * 12
            while pos < len(data):
                part = data[pos:pos + chunk]
                st, _, b = cloud._http("PUT", s["uploadUrl"], {"Content-Type": "application/octet-stream", "Content-Length": str(len(part)),
                                                               "Content-Range": f"bytes {pos}-{pos + len(part) - 1}/{len(data)}"}, part, timeout=300)
                if st not in (200, 201):
                    raise MailError("Microsoft Graph: " + (cloud._err_text(b) or str(st)))
                pos += len(part)
        self.call("POST", f"/me/messages/{d['id']}/send")
        return {"ora": time.time()}


def synthetic(m: dict) -> bytes:
    """Intestazioni RFC 822 dal JSON di Graph: bastano per elenco, conversazioni e ricerca finche' non arriva il MIME."""
    def addr(x):
        e = (x or {}).get("emailAddress") or {}
        return formataddr((e.get("name") or "", e.get("address") or ""))
    lines = []
    if m.get("from"):
        lines.append("From: " + addr(m["from"]))
    if m.get("toRecipients"):
        lines.append("To: " + ", ".join(addr(x) for x in m["toRecipients"]))
    if m.get("ccRecipients"):
        lines.append("Cc: " + ", ".join(addr(x) for x in m["ccRecipients"]))
    from email.header import Header
    lines.append("Subject: " + Header(m.get("subject") or "", "utf-8").encode())
    when = m.get("receivedDateTime") or m.get("sentDateTime")
    if when:
        try:
            lines.append("Date: " + format_datetime(datetime.fromisoformat(when.replace("Z", "+00:00"))))
        except ValueError:
            pass
    if m.get("internetMessageId"):
        lines.append("Message-ID: " + m["internetMessageId"])
    if m.get("importance") == "high":
        lines.append("Importance: High")
    lines.append("X-MBV-Graph: " + m["id"])
    return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8")
