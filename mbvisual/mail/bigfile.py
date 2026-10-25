"""Invii grandi: l'allegato pesante si carica nel cloud collegato (pannello Cloud: OneDrive/SharePoint, Google Drive,
Dropbox) in una cartella "MB Desk - Invii" e nel messaggio va un link di download in sola lettura al suo posto.

- OneDrive/SharePoint: link "chiunque abbia il link" (se l'organizzazione lo vieta: link per l'organizzazione) con
  scadenza a 30 giorni dove il piano lo permette.
- Google Drive: permesso "chiunque con il link: lettore".
- Dropbox: link condiviso pubblico (serve il permesso sharing.write: dopo l'aggiornamento si rifa' l'accesso a Dropbox).
"""
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .. import cloud
from ..i18n import t

FOLDER = "MB Desk - Invii"
DAYS = 30


def services() -> dict:
    st = cloud.status()
    return {"ok": True, "servizi": [{"id": s["id"], "nome": s["nome"], "connesso": s["connesso"]}
                                    for s in st["servizi"] if s["configurato"] and s["id"] in ("onedrive", "gdrive", "dropbox")]}


def upload(path, svc, update):
    src = Path(path)
    if not src.is_file():
        raise ValueError(t("srv_mail.allegato_non_trovato", src.name))
    if not svc:
        ok = [s["id"] for s in services()["servizi"] if s["connesso"]]
        if not ok:
            raise ValueError(t("mail.link_nessun_cloud"))
        svc = ok[0]
    sess = cloud.Session(svc)
    prov = cloud.PROVIDERS[svc]
    name = time.strftime("%Y-%m-%d %H%M%S ") + src.name
    update(0.02, t("mail.caricamento_link", src.name))
    if svc == "onedrive":
        d = sess.call("GET", prov.API + "/me/drive", params={"$select": "id"})["id"]
        fid = _graph_folder(sess, prov, d)
        meta = prov.upload_new(sess, f"d|{d}|{fid}", name, src, False, update)
        url, scade = _graph_link(sess, prov, meta["id"])
    elif svc == "gdrive":
        fid = _gdrive_folder(sess, prov)
        meta = prov.upload_new(sess, fid, name, src, False, update)
        sess.call("POST", f"{prov.API}/files/{meta['id']}/permissions", params={"supportsAllDrives": "true"}, js={"role": "reader", "type": "anyone"})
        url, scade = meta.get("web") or f"https://drive.google.com/file/d/{meta['id']}/view", ""
    elif svc == "dropbox":
        st, _, b = sess.call("POST", prov.API + "/files/create_folder_v2", js={"path": "/" + FOLDER, "autorename": False}, raw=True)
        if st not in (200, 409):
            raise cloud._status_error(prov.nome, st, b)
        meta = prov.upload_new(sess, "/" + FOLDER, name, src, False, update)
        url, scade = _dropbox_link(sess, prov, meta["id"]), ""
    else:
        raise ValueError(t("srv_cloud.servizio_sconosciuto"))
    return {"url": url, "scade": scade, "servizio": prov.nome, "nome": src.name, "size": src.stat().st_size}


def _graph_folder(sess, prov, d):
    st, _, b = sess.call("GET", f"{prov.API}/drives/{d}/root:/{cloud.quote(FOLDER)}", raw=True)
    if st == 200:
        return cloud._jsonb(b)["id"]
    x = sess.call("POST", f"{prov.API}/drives/{d}/root/children", js={"name": FOLDER, "folder": {}, "@microsoft.graph.conflictBehavior": "replace"})
    return x["id"]


def _graph_link(sess, prov, iid):
    d, i = prov._ids(iid)
    exp = (datetime.now(timezone.utc) + timedelta(days=DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for body in ({"type": "view", "scope": "anonymous", "expirationDateTime": exp}, {"type": "view", "scope": "anonymous"},
                 {"type": "view", "scope": "organization"}):
        st, _, b = sess.call("POST", f"{prov.API}/drives/{d}/items/{i}/createLink", js=body, raw=True)
        if st in (200, 201):
            j = cloud._jsonb(b)
            return j["link"]["webUrl"], (time.strftime("%d/%m/%Y", time.localtime(time.time() + DAYS * 86400)) if "expirationDateTime" in body else "")
    raise cloud._status_error(prov.nome, st, b)


def _gdrive_folder(sess, prov):
    q = f"name = '{prov._esc(FOLDER)}' and mimeType = '{prov.FOLDER}' and 'root' in parents and trashed = false"
    j = sess.call("GET", prov.API + "/files", params={"q": q, "fields": "files(id)", "spaces": "drive"})
    if j.get("files"):
        return j["files"][0]["id"]
    return sess.call("POST", prov.API + "/files", params={"fields": "id"}, js={"name": FOLDER, "mimeType": prov.FOLDER, "parents": ["root"]})["id"]


def _dropbox_link(sess, prov, path):
    st, _, b = sess.call("POST", prov.API + "/sharing/create_shared_link_with_settings",
                         js={"path": path, "settings": {"requested_visibility": "public", "audience": "public", "access": "viewer"}}, raw=True)
    if st == 200:
        return cloud._jsonb(b)["url"]
    j = sess.call("POST", prov.API + "/sharing/list_shared_links", js={"path": path, "direct_only": True})
    if j.get("links"):
        return j["links"][0]["url"]
    raise cloud._status_error(prov.nome, st, b)
