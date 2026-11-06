"""Archivi di Outlook .pst / .ost senza Outlook: libpff (pypff, LGPL-3.0) legge cartelle, messaggi, corpi e allegati.
All'apertura si legge solo l'indice (cartella, oggetto, mittente, data, numero di allegati) di TUTTI i messaggi, senza limiti;
il messaggio completo (corpo, destinatari, allegati salvati in TEMP) si legge quando lo si apre. Il file resta aperto in una piccola
cache per percorso + data; l'originale non si modifica mai. Elementi non di posta (contatti, appuntamenti, attivita') si mostrano
con il loro oggetto e il testo. Messaggi allegati ad altri messaggi: elencati per nome ma non estratti."""
import os
import re
import threading
from pathlib import Path

from .i18n import t as tr

_LOCK = threading.Lock()
_OPEN: dict = {}  # chiave -> (pypff.file, file python, indice)
_MAX_OPEN = 3

# proprieta' MAPI usate (tag senza tipo)
P_DISPLAY_TO, P_DISPLAY_CC, P_SENDER_EMAIL = 0x0E04, 0x0E03, 0x0C1F
P_MSG_CLASS = 0x001A
A_LONG_NAME, A_SHORT_NAME, A_MIME, A_CID, A_METHOD, A_DISPLAY = 0x3707, 0x3704, 0x370E, 0x3712, 0x3705, 0x3001


# livelli che Outlook mette sopra le cartelle dell'utente: non si mostrano nel nome della cartella
TECH_LEVELS = {"Top of Personal Folders", "Root - Mailbox", "IPM_SUBTREE", "Top of Outlook data file", "Root - Public"}


def _key(path: str) -> str:
    st = os.stat(path)
    return f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}"


def _props(item) -> dict:
    out = {}
    try:
        for r in range(item.number_of_record_sets):
            rs = item.get_record_set(r)
            for k in range(rs.number_of_entries):
                e = rs.get_entry(k)
                out.setdefault(e.entry_type, e)
    except Exception:  # noqa: BLE001
        pass
    return out


def _s(props: dict, tag: int) -> str:
    e = props.get(tag)
    if e is None:
        return ""
    try:
        v = e.get_data_as_string()
        return v or ""
    except Exception:  # noqa: BLE001
        d = e.data or b""
        return d.rstrip(b"\x00").decode("cp1252", "replace")


def _text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    for enc in ("utf-8", "cp1252"):
        try:
            return v.decode(enc).rstrip("\x00")
        except UnicodeDecodeError:
            continue
    return v.decode("latin-1", "replace")


def _html(v) -> str:
    if not v:
        return ""
    if isinstance(v, str):
        return v
    m = re.search(rb'charset=["\']?([A-Za-z0-9_\-]+)', v[:4000])
    if m:
        try:
            return v.decode(m.group(1).decode("ascii"), "replace").rstrip("\x00")
        except LookupError:
            pass
    return _text(v)


def _rtf(v) -> tuple[str, str]:
    """(html, testo) da un corpo RTF: HTML/testo incapsulati da Outlook con RTFDE, altrimenti testo ripulito dai comandi."""
    if not v:
        return "", ""
    raw = v if isinstance(v, bytes) else v.encode("latin-1", "replace")
    raw = raw.rstrip(b"\x00")
    try:
        from RTFDE.deencapsulate import DeEncapsulator
        d = DeEncapsulator(raw)
        d.deencapsulate()
        if d.get_type() == "html":
            h = d.html
            return (h.decode("utf-8", "replace") if isinstance(h, bytes) else h), ""
        tx = d.text
        return "", (tx.decode("utf-8", "replace") if isinstance(tx, bytes) else tx)
    except Exception:  # noqa: BLE001 - RTF non incapsulato: testo approssimato
        pass
    s = raw.decode("cp1252", "replace")
    s = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes([int(m.group(1), 16)]).decode("cp1252", "replace"), s)
    s = re.sub(r"\{\\\*[^{}]*\}", "", s)
    s = re.sub(r"\\(par|line)\b ?", "\n", s)
    s = re.sub(r"\\tab\b ?", "\t", s)
    s = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", s)
    s = s.replace("{", "").replace("}", "")
    return "", re.sub(r"\n{3,}", "\n\n", s).strip()


def _header(headers: str, name: str) -> str:
    m = re.search(r"(?im)^" + name + r":[ \t]*(.*(?:\r?\n[ \t]+.*)*)", headers or "")
    if not m:
        return ""
    val = re.sub(r"\r?\n[ \t]+", " ", m.group(1)).strip()
    try:
        from email.header import decode_header, make_header
        return str(make_header(decode_header(val)))
    except Exception:  # noqa: BLE001
        return val


def _when(m) -> str:
    for attr in ("delivery_time", "client_submit_time", "creation_time"):
        try:
            v = getattr(m, attr)
        except Exception:  # noqa: BLE001
            v = None
        if v:
            return v.strftime("%Y-%m-%d %H:%M")
    return ""


def _folder_name(fo, depth) -> str:
    try:
        n = fo.name
    except Exception:  # noqa: BLE001
        n = None
    return n or (tr("srv_pst.radice") if depth == 0 else "?")


def _open(path: str):
    k = _key(path)
    with _LOCK:
        if k in _OPEN:
            return _OPEN[k]
    import pypff
    fh = open(path, "rb")
    pf = pypff.file()
    try:
        pf.open_file_object(fh)
    except Exception as e:  # noqa: BLE001
        fh.close()
        msg = str(e)
        if "encrypt" in msg.lower() or "password" in msg.lower():
            raise ValueError(tr("srv_pst.protetto")) from e
        raise ValueError(tr("srv_pst.non_leggibile")) from e
    idx = []  # (percorso indici cartelle, indice messaggio, nome cartella, riepilogo)
    folders = []

    def walk(fo, trail, names, depth):
        try:
            n_msg = fo.number_of_sub_messages
        except Exception:  # noqa: BLE001
            n_msg = 0
        shown = [n for n in names[1:] if n not in TECH_LEVELS]
        label = " / ".join(shown) if shown else names[-1]
        if n_msg:
            folders.append({"nome": label, "da": len(idx), "n": n_msg})
        for i in range(n_msg):
            try:
                m = fo.get_sub_message(i)
                subj = m.subject or ""
                sender = m.sender_name or ""
                when = _when(m)
                try:
                    na = m.number_of_attachments
                except Exception:  # noqa: BLE001
                    na = 0
            except Exception:  # noqa: BLE001 - un elemento rovinato non ferma gli altri
                subj, sender, when, na = tr("srv_pst.elemento_illeggibile"), "", "", 0
            idx.append((trail, i, label, {"oggetto": subj, "da": sender, "data": when, "na": na, "cartella": label}))
        try:
            n_sub = fo.number_of_sub_folders
        except Exception:  # noqa: BLE001
            n_sub = 0
        for j in range(n_sub):
            try:
                sub = fo.get_sub_folder(j)
            except Exception:  # noqa: BLE001
                continue
            walk(sub, trail + (j,), names + [_folder_name(sub, depth + 1)], depth + 1)

    root = pf.get_root_folder()
    walk(root, (), [_folder_name(root, 0)], 0)
    entry = (pf, fh, idx, folders)
    with _LOCK:
        _OPEN[k] = entry
        while len(_OPEN) > _MAX_OPEN:
            old = next(iter(_OPEN))
            o = _OPEN.pop(old)
            try:
                o[0].close()
                o[1].close()
            except Exception:  # noqa: BLE001
                pass
    return entry


def index(path: str) -> dict:
    _, _, idx, folders = _open(path)
    return {"ok": True, "pst": True, "cartelle": folders, "messaggi": [x[3] for x in idx]}


def message(path: str, i: int, save_attachment) -> dict:
    pf, _, idx, _ = _open(path)
    if not 0 <= i < len(idx):
        raise ValueError(tr("srv_pst.non_trovato"))
    trail, mi, label, summ = idx[i]
    with _LOCK:  # libpff non e' sicuro tra thread sullo stesso file
        fo = pf.get_root_folder()
        for j in trail:
            fo = fo.get_sub_folder(j)
        m = fo.get_sub_message(mi)
        props = _props(m)
        try:
            headers = m.transport_headers or ""
        except Exception:  # noqa: BLE001
            headers = ""
        html = testo = ""
        try:
            html = _html(m.html_body)
        except Exception:  # noqa: BLE001
            pass
        try:
            testo = _text(m.plain_text_body)
        except Exception:  # noqa: BLE001
            pass
        if not html and not testo:
            try:
                html, testo = _rtf(m.rtf_body)
            except Exception:  # noqa: BLE001
                pass
        sender = summ["da"]
        mail_from = _header(headers, "From")
        if not mail_from:
            em = _s(props, P_SENDER_EMAIL)
            mail_from = f"{sender} <{em}>" if em and em.lower() != sender.lower() else (sender or em)
        to = _header(headers, "To") or _s(props, P_DISPLAY_TO)
        cc = _header(headers, "Cc") or _s(props, P_DISPLAY_CC)
        date = _header(headers, "Date") or summ["data"]
        atts, cids = [], {}
        from .paths import TEMP_DIR
        import uuid
        dirp = TEMP_DIR / "email" / uuid.uuid4().hex[:8]
        dirp.mkdir(parents=True, exist_ok=True)
        try:
            na = m.number_of_attachments
        except Exception:  # noqa: BLE001
            na = 0
        for k in range(na):
            name = f"{tr('srv_pst.allegato')}_{k + 1}"
            try:
                a = m.get_attachment(k)
                ap = _props(a)
                name = _s(ap, A_LONG_NAME) or _s(ap, A_SHORT_NAME) or _s(ap, A_DISPLAY) or name
                mime = _s(ap, A_MIME)
                size = a.size or 0
                data = a.read_buffer(size) if size else b""
            except Exception:  # noqa: BLE001 - messaggio allegato o allegato OLE: non estratto
                atts.append({"nome": name, "path": None, "size": 0,
                             "tipo": "", "non_estratto": True})
                continue
            p = save_attachment(dirp, name, data)
            cid = _s(ap, A_CID).strip("<>")
            if cid:
                cids[cid] = p
            atts.append({"nome": Path(p).name, "path": p, "size": len(data), "tipo": mime})
    return {"ok": True, "messaggio": {"da": mail_from, "a": to, "cc": cc, "data": date, "oggetto": summ["oggetto"],
                                      "html": html or None, "testo": testo, "allegati": atts, "cid": cids,
                                      "cartella": label, "classe": _s(props, P_MSG_CLASS)}}
