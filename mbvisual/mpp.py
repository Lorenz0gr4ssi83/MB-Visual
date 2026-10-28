"""Microsoft Project .mpp / .mpt senza Project.

Lettore scritto da zero per i file di Project 2010-2024 ("MPP14": contenitore OLE con la cartella "   114"). Struttura
ricavata dai file (verificata confrontando i .mpp con l'XML MSPDI dello stesso progetto salvato da Project):
  - "   114/Props": proprieta' del progetto [u16 numero voci a 12] poi voci (i32 lunghezza, i32 chiave, i32) + dati
    allineati a 2 byte. Chiavi usate: 131092/131093/131095 = mappe dei campi di attivita'/risorse/assegnazioni,
    37748738 inizio del progetto, 37748765 minuti al giorno, 37748766 minuti a settimana, 37753743 giorni al mese.
  - mappa dei campi: voci da 28 byte (u32 maschera, u16 posizione nei dati fissi o 0xFFFF, u32 numero del campo di
    Project a 12 = PjField, u16 categoria a 20). Le posizioni che tornano indietro passano al secondo blocco fisso.
    Categorie: 0x02 short, 0x03 int, 0x05 double, 0x08 testo, 0x13 data, 0x65 lavoro/costo, 0x66 unita',
    0x1D byte, 0x0B/0x64 indicatori nei metadati. Campi non fissi: dati variabili con chiave = numero del campo & 0xFFFF.
  - "TBkndTask|Rsc|Assn": FixedMeta (16 byte di intestazione, poi elementi: i32 indicatori, i32 posizione nei dati),
    FixedData / Fixed2Data, VarMeta (24 byte, poi voci uid i32, posizione i32, chiave u16, u16) e Var2Data
    (alla posizione: i32 lunghezza + dati). "TBkndCons" = collegamenti (20 byte: uid, predecessore, successore, tipo,
    ritardo). Date: u16 decimi di minuto + u16 giorni dal 31/12/1983. Durate: decimi di minuto.
I file piu' vecchi (Project 98-2007: "   19", "   112") non si leggono: si consiglia di salvarli come XML da Project.
Scrittura .mpp: solo con Microsoft Project installato (automazione COM: si passa per l'XML MSPDI).
"""

from __future__ import annotations

import datetime as _dt
import os
import re
import struct
import tempfile

from .i18n import t

EPOCH = _dt.datetime(1983, 12, 31)


class MppError(Exception):
    pass


def _u16(b, o):
    return struct.unpack_from("<H", b, o)[0] if b is not None and o + 2 <= len(b) else None


def _i32(b, o):
    return struct.unpack_from("<i", b, o)[0] if b is not None and o + 4 <= len(b) else None


def _f64(b, o):
    return struct.unpack_from("<d", b, o)[0] if b is not None and o + 8 <= len(b) else None


def _ts(b, o):
    """data e ora -> 'AAAA-MM-GGThh:mm' o None"""
    if b is None or o + 4 > len(b):
        return None
    tm, days = struct.unpack_from("<HH", b, o)
    if days <= 1 or days == 65535:
        return None
    if tm == 65535:
        tm = 0
    d = EPOCH + _dt.timedelta(days=days, seconds=tm * 6)
    return d.strftime("%Y-%m-%dT%H:%M")


def _props(b: bytes) -> dict:
    out = {}
    if len(b) < 16:
        return out
    cnt = _u16(b, 12)
    i = 16
    while i + 12 <= len(b) and len(out) < cnt:
        ln, key, _ = struct.unpack_from("<iii", b, i)
        i += 12
        if ln < 1 or i + ln > len(b):
            break
        out[key] = b[i:i + ln]
        i += ln + (ln & 1)
    return out


class FieldMap:
    def __init__(self, data: bytes | None, type_key: bool = True):
        self.f = {}
        if not data:
            return
        blk, last = 0, 0
        for i in range(0, len(data) - 27, 28):
            mask, off = struct.unpack_from("<IH", data, i)
            typ = _i32(data, i + 12) & 0xFFFFFFFF
            cat = _u16(data, i + 20)
            if off != 0xFFFF and cat not in (0x0B, 0x64):
                if off < last:
                    blk += 1
                last = off
            key = typ & 0xFFFF if type_key else data[i + 6]  # Project 2007: chiave dei dati variabili nel byte 6
            self.f[typ & 0xFFFF] = (off if off != 0xFFFF and cat not in (0x0B, 0x64) else None, blk, cat, key, mask)


class Table:
    """Una tabella TBknd*: righe fisse (uno o due blocchi) + dati variabili per uid."""

    def __init__(self, ole, d, item_fixed=None):
        def rd(n):
            p = d + "/" + n
            return ole.openstream(p).read() if ole.exists(p) else b""
        self.var = {}
        vm, vd = rd("VarMeta"), rd("Var2Data")
        if len(vm) >= 24:
            n = _i32(vm, 8)
            for k in range(n):
                o = 24 + k * 12
                if o + 12 > len(vm):
                    break
                uid, off, key = struct.unpack_from("<iiH", vm, o)
                if 0 <= off and off + 4 <= len(vd):
                    ln = _i32(vd, off)
                    if 0 <= ln <= len(vd) - off - 4:
                        self.var[(uid, key)] = vd[off + 4:off + 4 + ln]
        self.meta, self.rows = self._fixed(rd("FixedMeta"), rd("FixedData"), item_fixed)
        self.meta2, self.rows2 = self._fixed(rd("Fixed2Meta"), rd("Fixed2Data"), None, len(self.rows))

    @staticmethod
    def _fixed(meta: bytes, data: bytes, rec_size, count_hint=None):
        if len(meta) < 16:
            return [], []
        n = _i32(meta, 8)
        avail = len(meta) - 16
        size = avail // n if n else 0
        if count_hint and avail and avail % count_hint == 0 and 8 <= avail // count_hint <= 200:
            size = avail // count_hint
        if size < 8:
            return [], []
        metas = [meta[16 + k * size:16 + (k + 1) * size] for k in range(avail // size)]
        offs = [_i32(m, 4) for m in metas]
        rows = []
        for k, m in enumerate(metas):
            o = offs[k]
            if o is None or o < 0 or o > len(data):
                rows.append(None)
                continue
            if rec_size:
                e = o + rec_size
            else:
                nxt = [x for x in offs[k + 1:k + 2] if x is not None and x >= o]
                e = nxt[0] if nxt and nxt[0] > o else len(data)
            rows.append(data[o:min(e, len(data))])
        return metas, rows

    def vbytes(self, uid, key):
        return self.var.get((uid, key))


class Reader:
    def __init__(self, path: str):
        import olefile
        if not olefile.isOleFile(path):
            raise MppError(t("srv_mpp.non_ole"))
        self.ole = olefile.OleFileIO(path)
        comp = self.ole.openstream("\x01CompObj").read() if self.ole.exists("\x01CompObj") else b""
        m = re.search(rb"MSProject\.(MPP|MPT|GLOBAL)(\d+)", comp)
        self.fmt = int(m.group(2)) if m else 0
        v = re.search(rb"Project (\d+)\.", comp)
        self.appver = int(v.group(1)) if v else 14
        self.root = "   114" if self.ole.exists("   114/Props") else "   112" if self.ole.exists("   112/Props") else None
        if not self.root:
            if self.fmt in (8, 9) or self.ole.exists("   19") or self.ole.exists("   18"):
                raise MppError(t("srv_mpp.vecchio", {8: "98", 9: "2000-2003"}.get(self.fmt, "")))
            raise MppError(t("srv_mpp.non_project"))
        self.v12 = self.root == "   112"
        self.props = _props(self.ole.openstream(self.root + "/Props").read())

    def _encrypted(self):
        # i file protetti da password hanno l'indicatore nelle proprieta' principali (Props14 a 0x0E)
        try:
            p = self.ole.openstream("Props14").read() if self.ole.exists("Props14") else b""
            return len(p) > 0x10 and (p[0x0E] & 0x02) != 0 and self.ole.exists("   114/Props") is False
        except Exception:
            return False

    # ---------------------------------------------------------------- valori
    def _val(self, fm: FieldMap, tab: Table, uid, idx, rows, kind=None):
        f = fm.f.get(idx)
        if not f:
            return None
        off, blk, cat, key, _ = f
        kind = kind or {0x02: "short", 0x03: "int", 0x05: "double", 0x08: "str", 0x13: "date", 0x65: "double", 0x66: "double", 0x1D: "bytes"}.get(cat)
        if off is not None:
            b = rows[blk] if blk < len(rows) else None
            if b is None:
                return None
            return {"short": _u16, "int": _i32, "double": _f64, "date": _ts}.get(kind, _i32)(b, off)
        b = tab.vbytes(uid, key)
        if b is None:
            return None
        if kind == "str":
            s = b.decode("utf-16-le", "replace")
            return s.split("\x00", 1)[0]
        if kind == "date":
            return _ts(b, 0)
        if kind == "short":
            return _u16(b, 0)
        if kind == "int":
            return _i32(b, 0)
        if kind == "double":
            return _f64(b, 0)
        return b

    def project(self):
        P = self.props
        g = lambda k, f, d=None: (f(P[k], 0) if k in P and f(P[k], 0) is not None else d)
        out = {"start": g(37748738, _ts), "mpd": g(37748765, _i32, 480), "mpw": g(37748766, _i32, 2400), "dpm": g(37753743, _u16, 20)}
        try:
            si = self.ole.get_metadata()
            dec = lambda v: v.decode("cp1252", "replace") if isinstance(v, bytes) else (v or "")
            out.update(title=dec(si.title), author=dec(si.author), company=dec(si.company), manager=dec(getattr(si, "manager", b"")))
        except Exception:
            pass
        if not out["mpd"] or out["mpd"] <= 0:
            out["mpd"] = 480
        return out

    def tasks(self):
        fm = FieldMap(self.props.get(131092) or self.props.get(50331668))
        tab = Table(self.ole, self.root + "/TBkndTask")
        old = self.appver <= 14
        ms_pos = (8, 0x20) if old else (10, 0x02)
        byuid = {}
        uid_off = fm.f.get(86, (None,))[0]
        id_off = fm.f.get(23, (None,))[0]
        for k, row in enumerate(tab.rows):
            if row is None or k < 0 or uid_off is None or len(row) < uid_off + 4:
                continue
            meta = tab.meta[k]
            flags = _i32(meta, 0) or 0
            if flags & 0x02:
                continue  # eliminata
            uid = _i32(row, uid_off)
            tid = _i32(row, id_off) if id_off is not None else None
            if uid is None or uid <= 0 or tid is None or tid <= 0:
                continue
            row2 = tab.rows2[k] if k < len(tab.rows2) else None
            rows = [row, row2]
            name = self._val(fm, tab, uid, 14, rows)
            if uid in byuid and not name:
                continue
            if len(row) < 32:  # attivita' vuota (riga senza dati)
                byuid[uid] = {"uid": uid, "id": tid, "name": "", "isNull": True}
                continue
            V = lambda i, kind=None: self._val(fm, tab, uid, i, rows, kind)
            units = V(152, "short")
            du = {3: "m", 4: "em", 5: "h", 6: "eh", 7: "d", 8: "ed", 9: "w", 10: "ew", 11: "mo", 12: "emo"}.get((units or 7) & 0x1F, "d")
            est = bool(units and units & 0x20) if units else False
            meta2 = tab.meta2[k] if k < len(tab.meta2) else b""
            # l'indicatore "programmata manualmente" non ha una posizione stabile tra le versioni: lo ricava l'interfaccia
            # confrontando le date salvate con quelle ricalcolate (pio.fromEngine)
            manual = False
            active = True
            dur10 = V(29, "int") or 0
            start = V(35, "date") or V(1283, "date")
            finish = V(36, "date") or V(1284, "date")
            if not manual:
                start = V(1338, "date") or start
                finish = V(1339, "date") or finish
                d2 = V(1340, "int")
                if d2 is not None and d2 >= 0:
                    dur10 = d2
            notes = V(15, "bytes")
            task = {
                "uid": uid, "id": tid, "name": name or "", "lvl": V(249, "short") or V(85, "short") or 1,
                "dur": max(0, round(dur10 / 10)), "du": du, "est": est,
                "ms": bool(len(meta) > ms_pos[0] and meta[ms_pos[0]] & ms_pos[1]), "manual": manual,
                "start": start, "finish": finish, "ct": V(17, "short") or 0, "cd": V(18, "date"), "dl": V(437, "date"),
                "pct": V(32, "short") or 0, "notes": _rtf_text(notes) if notes else "", "cal": None,
                "as": V(41, "date"), "af": V(42, "date"), "pri": V(25, "short") or 500, "act": active,
                "fc": round((V(8, "double") or 0) / 100, 2), "preds": [], "bl": [],
                "parent": V(160, "int"),
            }
            cal = V(401, "int")
            if cal and cal > 0:
                task["cal"] = cal
            if task["ct"] not in range(8) or task["ct"] < 2:
                task["cd"] = None if task["ct"] < 2 else task["cd"]
                if task["ct"] not in range(8):
                    task["ct"] = 0
            if task["pct"] > 100:
                task["pct"] = 0
            bs, bf = V(43, "date"), V(44, "date")
            if bs or bf:
                task["bl"] = [{"start": bs, "finish": bf, "dur": round((V(27, "int") or 0) / 10), "work": 0, "cost": 0}]
            byuid[uid] = task
        tasks = sorted(byuid.values(), key=lambda x: x["id"])
        tasks = [x for x in tasks if x["id"] > 0]
        # livelli dal padre se il campo manca
        lv = {}
        for x in tasks:
            if x.get("isNull"):
                continue
            p = x.pop("parent", None)
            if p and p in lv:
                x["lvl"] = lv[p] + 1
            lv[x["uid"]] = x.get("lvl", 1)
        for x in tasks:
            x.pop("id", None)
            x.pop("parent", None)
        return tasks

    def relations(self, tasks):
        d = self.root + "/TBkndCons"
        if not self.ole.exists(d + "/FixedData"):
            return
        meta = self.ole.openstream(d + "/FixedMeta").read()
        data = self.ole.openstream(d + "/FixedData").read()
        n = _i32(meta, 8) or 0
        size = (len(meta) - 16) // n if n else 10
        by = {x["uid"]: x for x in tasks}
        new = self.appver > 14
        for k in range(n):
            m = meta[16 + k * size:16 + (k + 1) * size]
            if len(m) < 8 or _u16(m, 0) != 0:
                continue
            o = _i32(m, 4)
            r = data[o:o + 20]
            if len(r) < 14:
                continue
            p, s, typ = _i32(r, 4), _i32(r, 8), _u16(r, 12)
            if not p or not s or p == s or s not in by or p not in by:
                continue
            lag10 = _i32(r, 14 if new else 16) or 0
            lu = _u16(r, 18 if new else 14) or 7
            unit = {3: "m", 4: "em", 5: "h", 6: "eh", 7: "d", 8: "ed", 9: "w", 10: "ew", 11: "mo", 12: "emo"}.get(lu & 0x1F, "d")
            L = {"u": p, "t": typ if typ in (0, 1, 2, 3) else 1, "lag": round(lag10 / 10), "lu": unit}
            if (lu & 0x1F) in (19, 20):
                L.update(pc=lag10 / 10, lag=0, lu="d")
            by[s]["preds"].append(L)

    def resources(self):
        fm = FieldMap(self.props.get(131093) or self.props.get(50331669))
        tab = Table(self.ole, self.root + "/TBkndRsc")
        out = {}
        uid_off = fm.f.get(27, (None,))[0]
        for k, row in enumerate(tab.rows):
            if row is None or uid_off is None or len(row) < uid_off + 4:
                continue
            if (_i32(tab.meta[k], 0) or 0) & 0x02:
                continue
            uid = _i32(row, uid_off)
            if not uid or uid <= 0:
                continue
            rows = [row, tab.rows2[k] if k < len(tab.rows2) else None]
            V = lambda i, kind=None: self._val(fm, tab, uid, i, rows, kind)
            name = V(1, "str")
            if not name:
                continue
            typ = V(300, "short")
            rate = V(6, "double") or 0
            out[uid] = {"uid": uid, "name": name, "type": {0: "material", 2: "cost"}.get(typ, "work"), "ini": V(2, "str") or "",
                        "group": V(3, "str") or "", "max": round((V(4, "double") or 10000) / 10000, 4), "rate": round(rate * 60 if typ != 0 else rate, 4),
                        "ovt": round((V(7, "double") or 0) * 60, 4), "use": round((V(18, "double") or 0) / 100, 2), "label": V(299, "str") or "",
                        "email": V(35, "str") or ""}
        return list(out.values())

    def assignments(self, tasks, res):
        fm = FieldMap(self.props.get(131095) or self.props.get(50331671))
        d = self.root + "/TBkndAssn"
        if not self.ole.exists(d + "/FixedMeta"):
            return []
        meta = self.ole.openstream(d + "/FixedMeta").read()
        data = self.ole.openstream(d + "/FixedData").read()
        n = _i32(meta, 8) or 0
        size = 34
        tu, ru = {x["uid"] for x in tasks}, {r["uid"]: r for r in res}
        out = []
        f = lambda i: fm.f.get(i, (None,))[0]
        for k in range(n):
            m = meta[16 + k * size:16 + (k + 1) * size]
            if len(m) < 8 or m[0] != 0:
                continue
            o = _i32(m, 4)
            r = data[o:o + 110]
            if len(r) < 24:
                continue
            uid, task, rsc = _i32(r, f(0) or 0), _i32(r, f(1) or 4), _i32(r, f(2) or 8)
            if task not in tu or rsc not in ru:
                continue
            units = _f64(r, f(7) or 12)
            work = _f64(r, f(8) or 20)
            a = {"uid": uid, "task": task, "res": rsc, "units": round((units or 10000) / 10000, 4), "w": round(work / 1000 * 60 / 60) if work is not None else None}
            if ru[rsc]["type"] == "material":
                a["units"] = round((units or 0) / 100, 4)
                a["w"] = None
            if ru[rsc]["type"] == "cost":
                c = _f64(r, f(26) or 68)
                a["cost"] = round((c or 0) / 100, 2)
                a["w"] = None
            out.append(a)
        return out

    def read(self):
        pj = self.project()
        tasks = self.tasks()
        self.relations(tasks)
        res = self.resources()
        assn = self.assignments(tasks, res)
        pj.update(tasks=tasks, resources=res, assignments=assn, version=self.appver)
        return pj


def _rtf_text(b: bytes) -> str:
    """note: in Project sono RTF; si tiene il testo"""
    try:
        s = b.decode("latin-1")
    except Exception:
        return ""
    if not s.lstrip().startswith("{\\rtf"):
        return s.replace("\x00", "").strip()
    out, i, depth, skip = [], 0, 0, []
    while i < len(s):
        c = s[i]
        if c == "{":
            depth += 1
            m = re.match(r"\{\\\*?\\?(fonttbl|colortbl|stylesheet|info|\*)", s[i:])
            skip.append(bool(m) or (skip[-1] if skip else False))
            i += 1
        elif c == "}":
            depth -= 1
            if skip:
                skip.pop()
            i += 1
        elif c == "\\":
            m = re.match(r"\\([a-z]+)(-?\d+)? ?|\\'([0-9a-f]{2})|\\(.)", s[i:], re.I)
            if not m:
                i += 1
                continue
            if not (skip and skip[-1]):
                if m.group(1) in ("par", "line"):
                    out.append("\n")
                elif m.group(1) == "tab":
                    out.append("\t")
                elif m.group(1) == "u" and m.group(2):
                    out.append(chr(int(m.group(2)) % 65536))
                    i += len(m.group(0))
                    if i < len(s) and s[i] == "?":
                        i += 1
                    continue
                elif m.group(3):
                    out.append(bytes([int(m.group(3), 16)]).decode("cp1252", "replace"))
                elif m.group(4) in ("\\", "{", "}"):
                    out.append(m.group(4))
            i += len(m.group(0))
        elif c in "\r\n":
            i += 1
        else:
            if not (skip and skip[-1]):
                out.append(c)
            i += 1
    return "".join(out).strip()


def read(path: str) -> dict:
    try:
        return Reader(path).read()
    except MppError:
        raise
    except Exception as e:  # file danneggiato o variante non riconosciuta
        raise MppError(t("srv_mpp.illeggibile", str(e))) from e


# ------------------------------------------------------------------ scrittura con Microsoft Project
def project_installed() -> bool:
    try:
        import winreg
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "MSProject.Application"))
        return True
    except Exception:
        return False


def write_with_project(xml: bytes, dest: str) -> None:
    """XML MSPDI -> .mpp con Microsoft Project (automazione). Senza Project: MppError."""
    if not project_installed():
        raise MppError(t("srv_mpp.serve_project"))
    import pythoncom
    import win32com.client
    tmp = tempfile.NamedTemporaryFile(suffix=".xml", delete=False)
    tmp.write(xml)
    tmp.close()
    pythoncom.CoInitialize()
    app = None
    try:
        app = win32com.client.DispatchEx("MSProject.Application")
        app.Visible = False
        app.DisplayAlerts = False
        app.FileOpenEx(tmp.name, False, 0, None, None, None, None, None, None, "MSProject.XMLFormat")
        fmt = "MSProject.MPT" if dest.lower().endswith(".mpt") else "MSProject.MPP"
        app.FileSaveAs(os.path.abspath(dest), 0, False, None, None, None, None, None, None, fmt)
        app.FileCloseEx(0)
    finally:
        try:
            if app is not None:
                app.Quit(0)
        except Exception:
            pass
        pythoncom.CoUninitialize()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
