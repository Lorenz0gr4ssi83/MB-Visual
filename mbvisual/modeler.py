"""Modellazione 3D di solidi: ponte tra l'interfaccia (ui/js/modeler) e il motore OpenCascade (mbvisual/modkernel.py).

Il motore gira in un processo a parte (OCP pesa centinaia di MB e un errore grave di OpenCascade non deve chiudere l'app):
si avvia alla prima richiesta e resta acceso per tutte le schede di modellazione. Le richieste passano una alla volta.
Se il processo si ferma (errore grave o "Interrompi"), alla richiesta successiva riparte: il documento sta nell'interfaccia
e si ricalcola da capo.

File .mbmod = zip con document.json (cronologia delle lavorazioni, schizzi con vincoli, parametri, aspetto dei corpi),
forme/ = forme importate (BREP binario di OpenCascade o mesh), anteprima.glb (vista per il telefono e per chi non ha il
motore) e anteprima.png.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from pathlib import Path

from .i18n import t
from .paths import NO_WINDOW, TEMP_DIR

DATA = TEMP_DIR / "modellatore"
BLOB = DATA / "blob"
OUT = DATA / "uscite"
FORMAT = "mbmod-1"
CAD_EXTS = {"step", "stp", "p21", "iges", "igs", "brep", "brp"}
SOLID_EXTS = {"sldprt", "sldasm", "par", "psm", "asm", "x_t", "x_b", "xmt_txt", "xmt_bin", "p_t", "p_b"}


def available() -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec("OCP") is not None
    except Exception:  # noqa: BLE001
        return False


class KernelError(Exception):
    def __init__(self, key, args=()):
        self.key = key
        self.kargs = list(args)
        super().__init__(t(key, *self.kargs) if key.startswith("srv_") else key)


class _Kernel:
    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()
        self.next = 1

    def _cmd(self):
        if getattr(sys, "frozen", False):
            return [sys.executable, "--modeler-kernel", str(DATA)]
        return [sys.executable, "-m", "mbvisual.modkernel", "--modeler-kernel", str(DATA)]

    def _start(self):
        DATA.mkdir(parents=True, exist_ok=True)
        log = open(DATA / "motore.log", "ab")
        root = Path(__file__).resolve().parent.parent
        self.proc = subprocess.Popen(self._cmd(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                                     cwd=str(root), creationflags=NO_WINDOW, bufsize=0)
        first = self._read(timeout=180)
        if not first.get("ready"):
            raise KernelError("srv_modeler.motore_non_avviato")

    def _read(self, timeout=None):
        tag = b"@@MBK "
        while True:
            line = self.proc.stdout.readline()
            if not line:
                code = self.proc.poll()
                self.proc = None
                raise KernelError("srv_modeler.motore_interrotto", [code])
            if line.startswith(tag):
                return json.loads(line[len(tag):].decode("utf-8"))

    def request(self, op, **kw):
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            rid = self.next
            self.next += 1
            msg = json.dumps({"id": rid, "op": op, **kw}, separators=(",", ":")) + "\n"
            try:
                self.proc.stdin.write(msg.encode("utf-8"))
                self.proc.stdin.flush()
            except OSError:
                self.proc = None
                raise KernelError("srv_modeler.motore_interrotto", [""])
            while True:
                r = self._read()
                if r.get("id") == rid:
                    break
        if not r.get("ok"):
            raise KernelError(r.get("err") or "srv_modeler.errore_motore", r.get("args") or [])
        return r

    def stop(self):
        p = self.proc
        self.proc = None
        if p and p.poll() is None:
            try:
                p.kill()
            except OSError:
                pass


KERNEL = _Kernel()


def _out_file():
    OUT.mkdir(parents=True, exist_ok=True)
    # file vecchi delle risposte: si tengono solo quelli degli ultimi minuti
    now = time.time()
    for f in OUT.glob("*.bin"):
        try:
            if now - f.stat().st_mtime > 300:
                f.unlink()
        except OSError:
            pass
    return str(OUT / f"{uuid.uuid4().hex}.bin")


# ------------------------------------------------------------------------------------------------- operazioni
def regen(sid, doc, have=None, upto=None) -> bytes:
    out = _out_file()
    KERNEL.request("regen", sid=sid, doc=doc, have=have or [], upto=upto, out=out)
    with open(out, "rb") as f:
        data = f.read()
    try:
        os.remove(out)
    except OSError:
        pass
    return data


def measure(sid, doc, a, b=None) -> dict:
    r = KERNEL.request("measure", sid=sid, doc=doc, a=a, b=b)
    r.pop("id", None)
    r.pop("ok", None)
    return r


def _dxf_to_dwg(dxf, out, update=None):
    """DXF con i 3DSOLID -> DWG con ODA File Converter (formato chiuso di Autodesk: MB Desk non lo scrive da solo)."""
    from . import cadedit
    if not cadedit.find_oda():
        try:
            os.remove(dxf)
        except OSError:
            pass
        raise KernelError("srv_modeler.dwg_serve_oda")
    if update:
        update(0.9, t("srv_modeler.conversione_dwg"))
    cadedit.dxf_file_to_dwg(dxf, out)


def export(sid, doc, path, fmt, looks=None, bodies=None, update=None) -> dict:
    if update:
        update(0.1, t("srv_modeler.esportazione"))
    if fmt == "dwg":
        r = export(sid, doc, path + ".mbv-dwg.dxf", "dxf", looks, bodies, update)
        _dxf_to_dwg(path + ".mbv-dwg.dxf", path, update)
        return {**r, "path": path}
    tmp = path + ".mbv-tmp." + fmt
    r = KERNEL.request("export", sid=sid, doc=doc, path=tmp, fmt=fmt, looks=looks or {}, bodies=bodies,
                       name=Path(path).stem)
    os.replace(tmp, path)
    if fmt == "obj" and os.path.exists(os.path.splitext(tmp)[0] + ".mtl"):
        os.replace(os.path.splitext(tmp)[0] + ".mtl", os.path.splitext(path)[0] + ".mtl")
    if fmt == "gltf":
        b = os.path.join(os.path.dirname(tmp), Path(tmp).stem + ".bin")
        if os.path.exists(b):
            # il .gltf scritto cita il .bin con il nome provvisorio: si riscrive con quello definitivo
            final = Path(path).stem + ".bin"
            os.replace(b, os.path.join(os.path.dirname(path), final))
            g = json.loads(Path(path).read_text(encoding="utf-8"))
            g["buffers"][0]["uri"] = final
            Path(path).write_text(json.dumps(g), encoding="utf-8")
    return {"path": path, "corpi": r.get("n", 0), "esatti": r.get("esatti"), "a_facce": r.get("a_facce")}


IFC_EXTS = {"ifc"}


def solid_dxf(path, out, update=None) -> dict:
    """Modello aperto nel visualizzatore 3D (STEP, IGES, BREP, Inventor, SolidWorks, Solid Edge, Parasolid, IFC) -> DXF o DWG
    con veri solidi di AutoCAD (3DSOLID) letti dal file d'origine, non dai triangoli della vista."""
    update = update or (lambda *a, **k: None)
    ext = Path(path).suffix.lower().lstrip(".")
    tmp_step = None
    if ext in IFC_EXTS:
        from . import ifcstep
        DATA.mkdir(parents=True, exist_ok=True)
        tmp_step = str(DATA / (uuid.uuid4().hex + ".step"))
        ifcstep.convert(path, tmp_step, lambda p=None, m=None, **k: update(0.05 + 0.5 * (p or 0), m))
        files = [{"path": tmp_step, "name": Path(path).stem}]
    else:
        update(0.05, t("srv_modeler.lettura_file", Path(path).name))
        files = sources_for(path, update)
    if not files:
        raise KernelError("srv_modeler.nulla_da_importare")
    update(0.6, t("srv_modeler.solidi_autocad"))
    dwg = out.lower().endswith(".dwg")
    dxf = out + ".mbv-dwg.dxf" if dwg else out + ".mbv-tmp.dxf"
    try:
        r = KERNEL.request("dxf_files", files=files, out=dxf)
    finally:
        if tmp_step:
            try:
                os.remove(tmp_step)
            except OSError:
                pass
    if dwg:
        _dxf_to_dwg(dxf, out, update)
    else:
        os.replace(dxf, out)
    return {"path": out, "esatti": r.get("esatti", 0), "a_facce": r.get("a_facce", 0)}


SOLID_DXF_EXTS = CAD_EXTS | SOLID_EXTS | IFC_EXTS | {"stpz", "ipt", "iam"}


def _flatten_inventor(path, update=None):
    from . import inventor
    res = inventor.convert(path, str(TEMP_DIR / "inventor"), update)
    parts = res.get("parti") or {}
    out = []

    def mul(a, b):
        return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]

    def walk(nodes, m):
        for n in nodes or []:
            mm = mul(m, n.get("matrice") or inventor.IDENTITA)
            if n.get("figli"):
                walk(n["figli"], mm)
            elif n.get("parte") and (parts.get(n["parte"]) or {}).get("step"):
                out.append({"path": parts[n["parte"]]["step"], "m": mm[:12], "name": n.get("nome") or ""})

    walk(res.get("albero"), inventor.IDENTITA)
    return out


def sources_for(path, update=None) -> list[dict]:
    """File da importare -> elenco di STEP/IGES/BREP (con matrice di posizione per gli assiemi)."""
    ext = Path(path).suffix.lower().lstrip(".")
    if ext in CAD_EXTS:
        return [{"path": path, "name": Path(path).stem}]
    if ext == "stpz":
        import gzip
        DATA.mkdir(parents=True, exist_ok=True)
        dst = DATA / (uuid.uuid4().hex + ".step")
        with gzip.open(path, "rb") as fi, open(dst, "wb") as fo:
            shutil.copyfileobj(fi, fo)
        return [{"path": str(dst), "name": Path(path).stem}]
    if ext in ("ipt", "iam"):
        return _flatten_inventor(path, update)
    if ext in SOLID_EXTS:
        from . import solidcad
        r = solidcad.to_step(path, None, update)
        if not r.get("step"):
            raise KernelError("srv_modeler.file_non_leggibile", [Path(path).name])
        return [{"path": r["step"], "name": Path(path).stem}]
    raise KernelError("srv_modeler.formato_non_importabile", [ext])


def import_file(path, update=None) -> dict:
    if update:
        update(0.05, t("srv_modeler.lettura_file", Path(path).name))
    files = sources_for(path, update)
    if not files:
        raise KernelError("srv_modeler.nulla_da_importare")
    if update:
        update(0.6, t("srv_modeler.conversione_corpi"))
    r = KERNEL.request("import", files=files)
    return {"items": r["items"], "nome": Path(path).stem}


def import_steps(steps: list, name="", update=None) -> dict:
    """Testi STEP gia' pronti (es. solidi ACIS dei DWG convertiti da cad3d.py), con la matrice di posizione -> corpi."""
    DATA.mkdir(parents=True, exist_ok=True)
    files = []
    for s in steps:
        txt, m = (s, None) if isinstance(s, str) else (s.get("step") or "", s.get("m"))
        p = DATA / (uuid.uuid4().hex + ".step")
        p.write_text(txt, encoding="utf-8")
        files.append({"path": str(p), "name": name, "m": m})
    r = KERNEL.request("import", files=files)
    for f in files:
        try:
            os.remove(f["path"])
        except OSError:
            pass
    return {"items": r["items"]}


def import_mesh(data: bytes, parts: list, brep=True) -> dict:
    DATA.mkdir(parents=True, exist_ok=True)
    p = DATA / (uuid.uuid4().hex + ".tri")
    p.write_bytes(data)
    try:
        r = KERNEL.request("import_mesh", path=str(p), parts=parts, brep=brep)
    finally:
        try:
            os.remove(p)
        except OSError:
            pass
    return {"items": r["items"]}


def to_brep(blob) -> dict:
    return {"blob": KERNEL.request("to_brep", blob=blob)["blob"]}


def _blobs_of(doc):
    out = []
    for f in doc.get("features") or []:
        if f.get("type") == "import":
            out += [it["blob"] for it in f.get("items") or [] if it.get("blob")]
    return out


def _blob_file(blob):
    for ext in (".bbrep", ".brep", ".mbms"):
        p = BLOB / (blob + ext)
        if p.exists():
            return p
    return None


def open_doc(path) -> dict:
    """Legge un .mbmod: documento + forme importate copiate nell'archivio del motore."""
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if "document.json" not in names:
            raise KernelError("srv_modeler.file_non_valido")
        doc = json.loads(z.read("document.json").decode("utf-8"))
        BLOB.mkdir(parents=True, exist_ok=True)
        for n in names:
            if n.startswith("forme/") and len(n) > 6:
                dst = BLOB / n[6:]
                if not dst.exists():
                    dst.write_bytes(z.read(n))
    return {"doc": doc}


def save_doc(path, doc, sid, cdoc=None, looks=None, thumb=None, update=None) -> dict:
    """Scrive il .mbmod: documento, forme importate, anteprima glTF (dal documento compilato) e immagine."""
    if update:
        update(0.1, t("srv_modeler.salvataggio"))
    prev = None
    if cdoc is not None:
        prev = _out_file() + ".glb"
        try:
            KERNEL.request("export", sid=sid, doc=cdoc, path=prev, fmt="glb", looks=looks or {}, bodies=None, name="")
        except KernelError:
            prev = None  # documento vuoto o con errori: si salva senza anteprima
    tmp = path + ".mbv-tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/x-mbdesk-model", compress_type=zipfile.ZIP_STORED)
        doc = dict(doc)
        doc["format"] = FORMAT
        z.writestr("document.json", json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
        for b in sorted(set(_blobs_of(doc))):
            f = _blob_file(b)
            if f is None:
                raise KernelError("srv_modeler.file_importato_mancante", [b])
            z.write(f, "forme/" + f.name)
        if prev and os.path.exists(prev):
            z.write(prev, "anteprima.glb")
        if thumb:
            import base64
            z.writestr("anteprima.png", base64.b64decode(thumb.split(",", 1)[-1]))
    if prev:
        try:
            os.remove(prev)
        except OSError:
            pass
    if os.path.exists(path):
        bdir = TEMP_DIR / "backup"
        bdir.mkdir(exist_ok=True)
        shutil.copy2(path, bdir / f"{uuid.uuid4().hex[:6]}_{Path(path).name}")
    os.replace(tmp, path)
    return {"path": path, "size": os.path.getsize(path)}


def preview_of(path) -> bytes | None:
    try:
        with zipfile.ZipFile(path) as z:
            return z.read("anteprima.glb") if "anteprima.glb" in z.namelist() else None
    except (OSError, zipfile.BadZipFile):
        return None


def close(sid) -> None:
    if KERNEL.proc is not None:
        try:
            KERNEL.request("close", sid=sid)
        except KernelError:
            pass


def stop() -> None:
    KERNEL.stop()


def api(handler, qs):
    """Ingresso unico: /api/modeler?op=..."""
    from . import jobs
    op = (qs.get("op") or [""])[0]
    if op == "status":
        return handler._json({"ok": True, "available": available()})
    if not available():
        return handler._json({"ok": False, "errore": t("srv_modeler.non_disponibile"), "nativo": False})
    try:
        if op == "import_mesh":
            parts = json.loads((qs.get("parts") or ["[]"])[0])
            brep = (qs.get("brep") or ["1"])[0] == "1"
            return handler._json({"ok": True, **import_mesh(handler._body(), parts, brep)})
        b = handler._body_json() if handler.command == "POST" else {}
        if op == "regen":
            data = regen(b["sid"], b["doc"], b.get("have"), b.get("upto"))
            return handler._send(200, data, "application/octet-stream")
        if op == "clash":
            r = KERNEL.request("clash", sid=b["sid"], doc=b["doc"], tol=b.get("tol"), skip=b.get("skip"))
            return handler._json({"ok": True, "clash": r["clash"], "n": r["n"], "mesh": r.get("mesh") or []})
        if op == "measure":
            return handler._json({"ok": True, **measure(b["sid"], b["doc"], b.get("a"), b.get("b"))})
        if op == "export":
            return handler._json({"ok": True, "job": jobs.start(export, b["sid"], b["doc"], b["path"], b["fmt"], b.get("looks"), b.get("bodies"))})
        if op == "solid_dxf":
            return handler._json({"ok": True, "job": jobs.start(solid_dxf, b["path"], b["out"])})
        if op == "iso":
            from . import modiso
            return handler._json({"ok": True, "job": jobs.start(modiso.make, b["path"], b["data"], b.get("fmt") or "pdf")})
        if op == "import":
            return handler._json({"ok": True, "job": jobs.start(import_file, b["path"])})
        if op == "import_steps":
            return handler._json({"ok": True, "job": jobs.start(import_steps, b["steps"], b.get("name") or "")})
        if op == "to_brep":
            return handler._json({"ok": True, **to_brep(b["blob"])})
        if op == "open":
            return handler._json({"ok": True, **open_doc(b["path"])})
        if op == "save":
            return handler._json({"ok": True, "job": jobs.start(save_doc, b["path"], b["doc"], b["sid"], b.get("cdoc"), b.get("looks"), b.get("thumb"))})
        if op == "close":
            close(b.get("sid"))
            return handler._json({"ok": True})
        if op == "stop":
            stop()
            return handler._json({"ok": True})
        if op == "preview":
            data = preview_of(handler._path(qs))
            if data is None:
                return handler._json({"ok": False}, 404)
            return handler._send(200, data, "model/gltf-binary")
    except KernelError as e:
        return handler._json({"ok": False, "errore": str(e), "chiave": e.key, "args": e.kargs})
    return handler._json({"ok": False, "errore": t("srv_server.api_sconosciuta")}, 404)
