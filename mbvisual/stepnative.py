"""STEP e IGES grandi con OpenCascade nativo (OCP), in parallelo su tutti i core, con archivio delle conversioni.

Il lettore dell'interfaccia (occt-import-js, WebAssembly, un solo core) impiegava quasi 10 minuti per uno STEP da 300 MB.
Qui:
1. `bin/stepsplit/stepsplit-<arch>.exe` (tools/stepsplit) divide lo STEP in N file parziali: ognuno con tutta la struttura
   dell'assieme e circa 1/N dei solidi (i solidi enormi si dividono per gruppi di facce);
2. N processi (questo modulo con `--step-worker`) leggono una parte ciascuno con STEPCAFControl (nomi, colori, posizioni),
   comunicano l'ingombro, ricevono la freccia di triangolazione comune (0,1% della diagonale dell'intero modello, come il
   lettore dell'interfaccia), triangolano e scrivono un GLB (RWGltf_CafWriter, millimetri, Z in alto);
3. i GLB si uniscono in uno solo: i nodi si riconoscono dall'etichetta XCAF (stessa struttura in tutte le parti, verificata
   con un'impronta; altrimenti si rifa' tutto con un solo processo). Il GLB resta in cache (TEMP_DIR/modelli3d): dalla
   seconda apertura bastano pochi secondi.
OCP si importa SOLO nei processi di lavoro (pesante: 8 s e centinaia di MB), mai nell'app.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

from .i18n import t
from .model3dcache import CACHE_DIR, _key, _prune
from .paths import BIN_DIR, IS_WIN, NO_WINDOW, TEMP_DIR

VERSION = "1"  # alzare quando cambia l'uscita (GLB in cache rifatti)
SEP = "\x1f"  # nei nomi dei nodi scritti dai processi: <etichetta XCAF> SEP <nome>
PARTE_MB = 12  # dimensione indicativa di ogni parte (49 MB: 5 processi, 9 s invece di 21 con 2)
GENERIC = ("SOLID", "SHELL", "COMPOUND", "COMPSOLID", "FACE", "WIRE", "EDGE", "VERTEX")  # nomi dati da OpenCascade


def available() -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec("OCP") is not None
    except Exception:  # noqa: BLE001
        return False


def _splitter() -> Path | None:
    if not IS_WIN:
        return None
    from .shellint import native_arch
    p = BIN_DIR / "stepsplit" / f"stepsplit-{native_arch()}.exe"
    return p if p.is_file() else None


def _worker_cmd() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--step-worker"]
    return [sys.executable, "-m", "mbvisual.stepnative", "--step-worker"]


def _mem_bytes() -> tuple[int, int]:
    """Memoria fisica totale e libera."""
    if IS_WIN:
        class MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                        ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                        ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = MS()
        m.dwLength = ctypes.sizeof(MS)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return m.ullTotalPhys, m.ullAvailPhys
    return 16 * 1024 ** 3, 8 * 1024 ** 3


def _parts_for(size: int) -> int:
    """Numero di processi: uno ogni ~12 MB, non oltre i core e la memoria. Misure sul file da 297 MB: un processo con 1/12
    del file (31 MB, struttura compresa) arriva a ~620 MB, cioe' ~0,2 GB fissi + ~13,5 volte i byte della sua parte."""
    if os.environ.get("MBV_STEP_PARTI"):  # prove
        return max(1, int(os.environ["MBV_STEP_PARTI"]))
    cores = os.cpu_count() or 4
    total, free = _mem_bytes()
    budget = max(free, total * 0.45)
    n = max(1, min(math.ceil(size / (PARTE_MB * 1024 ** 2)), cores, 64))
    while n > 1 and n * 0.2 * 1024 ** 3 + 14 * size * (1.25 if n > 1 else 1) > budget:
        n -= 1
    return n


def _wjson(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    for _ in range(100):  # su Windows la sostituzione fallisce se l'altro processo sta leggendo proprio in quel momento
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.02)
    os.replace(tmp, path)


def _rjson(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ------------------------------------------------------------------------------------------------- conversione (app)
def convert(path: str, update=None) -> dict:
    """STEP/IGES -> GLB in cache. Restituisce {glb, info}."""
    update = update or (lambda *a, **k: None)
    if not available():
        raise RuntimeError(t("srv_step.non_disponibile"))
    t0 = time.time()
    k = _key(path, "stepglb", VERSION)
    glb, info_p = CACHE_DIR / (k + ".glb"), CACHE_DIR / (k + ".info.json")
    if glb.is_file() and info_p.is_file():
        now = time.time()
        for f in (glb, info_p):
            try:
                os.utime(f, (now, now))
            except OSError:
                pass
        return {"glb": str(glb), "info": _rjson(info_p) or {}, "cache": True}
    work = TEMP_DIR / "step" / k
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    try:
        size = os.path.getsize(path)
        ext = Path(path).suffix.lower()
        n = _parts_for(size)
        sp = _splitter()
        split = {"s": 0.0}
        if n > 1 and ext in (".step", ".stp", ".p21") and sp:
            # i processi partono subito (OpenCascade impiega qualche secondo ad avviarsi) mentre il file si divide
            parts = [str(work / f"parte{i}.step") for i in range(n)]

            def prepare():
                update(0.01, t("srv_step.divisione"))
                ts = time.time()
                r = subprocess.run([str(sp), path, str(work), str(n)], capture_output=True, timeout=600, creationflags=NO_WINDOW)
                split["s"] = time.time() - ts
                try:
                    res = json.loads(r.stdout.decode("utf-8", "replace").strip().splitlines()[-1])
                except (ValueError, IndexError):
                    return None
                return len(res["parti"]) if res.get("ok") and res.get("parti") else None
        else:
            parts, prepare = [path], None
        primo = None
        info = _run_workers(parts, work, update, size, prepare)
        if len(parts) > 1 and not info.get("ok"):
            # divisione non riuscita o struttura diversa tra le parti (non dovrebbe succedere): un solo processo
            update(0.02, t("srv_step.ripiego"))
            primo = info.get("errore")
            for f in work.glob("w*"):
                f.unlink(missing_ok=True)
            parts = [path]
            info = _run_workers(parts, work, update, size, None)
        split_s = split["s"]
        if not info.get("ok"):
            raise RuntimeError(info.get("errore") or t("srv_step.non_riuscito"))
        update(0.97, t("srv_step.unione"))
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = glb.with_suffix(".glb.tmp")
        tm = time.time()
        stats = merge_glb(info["glbs"], tmp)
        os.replace(tmp, glb)
        info.pop("glbs", None)
        info.update(stats)
        if primo:
            info["primo_tentativo"] = primo
        info.update({"parti": info.pop("n", len(parts)), "divisione_s": round(split_s, 2), "unione_s": round(time.time() - tm, 2),
                     "totale_s": round(time.time() - t0, 1), "versione": VERSION})
        _wjson(info_p, info)
        _prune_glb()
        return {"glb": str(glb), "info": info, "cache": False}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _prune_glb() -> None:
    _prune()  # stesso limite di spazio delle altre conversioni 3D
    try:
        files = sorted((f for f in CACHE_DIR.glob("*.glb")), key=lambda f: f.stat().st_mtime)
    except OSError:
        return
    total = sum(f.stat().st_size for f in files)
    while files and total > 4 * 1024 ** 3:
        f = files.pop(0)
        total -= f.stat().st_size
        f.unlink(missing_ok=True)
        f.with_suffix("").with_suffix(".info.json").unlink(missing_ok=True)


PHASES = {"avvio": 0.0, "import": 0.06, "lettura": 0.12, "trasferimento": 0.25, "ingombro": 0.75, "triangolazione": 0.78,
          "glb": 0.92, "fine": 1.0}


def _run_workers(parts: list[str], work: Path, update, size: int, prepare=None) -> dict:
    """Avvia un processo per parte. `prepare()` (se c'e') prepara i file delle parti mentre i processi si avviano e
    restituisce quante parti ha scritto (None = non riuscito): i processi in piu' si chiudono."""
    procs = []
    flags = NO_WINDOW | (0x00004000 if IS_WIN else 0)  # BELOW_NORMAL_PRIORITY_CLASS: l'interfaccia resta reattiva
    for i, p in enumerate(parts):
        st, dfl, out, go = work / f"w{i}.json", work / f"w{i}.defl", work / f"w{i}.glb", work / f"w{i}.go"
        for f in (st, dfl, out, go):
            f.unlink(missing_ok=True)
        cmd = _worker_cmd() + [p, str(out), str(st), str(dfl), str(os.getpid()), str(go)]
        cwd = None if getattr(sys, "frozen", False) else str(Path(__file__).resolve().parent.parent)
        # triangolazione su tutti i core solo con un processo; con un processo per core ognuno lavora da solo (piu' veloce)
        env = dict(os.environ, MBV_STEP_MESH_PAR="1" if len(parts) == 1 else "0")
        procs.append((subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, creationflags=flags), st, dfl, out))
    try:
        if prepare:
            got = prepare()
            for i, _ in enumerate(procs):
                (work / f"w{i}.go").write_text("ok" if got and i < got else "esci", encoding="utf-8")
            if not got:
                return {"ok": False, "errore": "divisione"}
            for pr, _, _, _ in procs[got:]:
                try:
                    pr.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pr.kill()
            del procs[got:]
        else:
            for i, _ in enumerate(procs):
                (work / f"w{i}.go").write_text("ok", encoding="utf-8")
    except BaseException:
        for pr, _, _, _ in procs:
            pr.kill()
        raise
    defl_sent = False
    last = 0.0
    try:
        while True:
            stats = [_rjson(st) or {"fase": "avvio"} for _, st, _, _ in procs]
            for (pr, st, _, _), s in zip(procs, stats):
                if s.get("errore"):
                    return {"ok": False, "errore": s["errore"]}
                if pr.poll() is not None and s.get("fase") != "fine":
                    s2 = _rjson(st) or {}
                    if s2.get("fase") != "fine":
                        return {"ok": False, "errore": s2.get("errore") or t("srv_step.processo_terminato", pr.returncode)}
            if not defl_sent and all(s.get("fase") in ("ingombro",) or "bbox" in s for s in stats):
                if len({s.get("impronta") for s in stats}) > 1:
                    return {"ok": False, "errore": "impronta"}
                boxes = [s["bbox"] for s in stats if s.get("bbox")]
                if boxes:
                    lo = [min(b[i] for b in boxes) for i in range(3)]
                    hi = [max(b[i + 3] for b in boxes) for i in range(3)]
                    diag = math.dist(lo, hi)
                else:
                    diag = 1000.0
                defl = max(diag * 0.001, 1e-4)
                for _, _, dfl, _ in procs:
                    dfl.write_text(repr(defl), encoding="utf-8")
                defl_sent = True
            if all(s.get("fase") == "fine" for s in stats):
                break
            prog = sum(PHASES.get(s.get("fase", "avvio"), 0.0) for s in stats) / len(stats)
            if time.time() - last > 0.3:
                fase = min((s.get("fase", "avvio") for s in stats), key=lambda f: PHASES.get(f, 0))
                update(0.03 + 0.93 * prog, t("srv_step.fase_" + fase, len(procs), round(size / 1048576)))
                last = time.time()
            time.sleep(0.15)
        for pr, _, _, _ in procs:
            pr.wait(timeout=60)
        stats = [_rjson(st) or {} for _, st, _, _ in procs]
        times = {k: round(max(s.get("tempi", {}).get(k, 0) for s in stats), 1)
                 for k in ("import", "lettura", "trasferimento", "triangolazione", "glb")}
        return {"ok": True, "n": len(procs), "glbs": [str(o) for _, _, _, o in procs], "tempi": times,
                "memoria_mb": [s.get("memoria_mb") for s in stats], "freccia": stats[0].get("freccia"),
                "tempi_processi": [{k: round(v, 1) for k, v in s.get("tempi", {}).items()} for s in stats]}
    finally:
        for pr, _, _, _ in procs:
            if pr.poll() is None:
                pr.kill()


# ------------------------------------------------------------------------------------------------ unione dei GLB
def _read_glb(p: str) -> tuple[dict, bytes]:
    b = Path(p).read_bytes()
    magic, _ver, _ln = struct.unpack_from("<III", b, 0)
    if magic != 0x46546C67:
        raise ValueError("GLB")
    jl, jt = struct.unpack_from("<II", b, 12)
    js = json.loads(b[20:20 + jl].decode("utf-8"))
    pos = 20 + jl
    bin_ = b""
    if pos + 8 <= len(b):
        bl, _bt = struct.unpack_from("<II", b, pos)
        bin_ = b[pos + 8:pos + 8 + bl]
    return js, bin_


def _entry_key(k: str) -> tuple:
    try:
        return tuple(int(x) for x in k.split(":"))
    except ValueError:
        return (1 << 30,)


def merge_glb(paths: list[str], out: Path) -> dict:
    """Unisce i GLB dei processi in uno: nodi con la stessa etichetta XCAF (sotto lo stesso padre) diventano uno solo."""
    res = {"asset": {"version": "2.0", "generator": "MB Desk"}, "scene": 0, "scenes": [{"nodes": []}], "nodes": [],
           "meshes": [], "accessors": [], "bufferViews": [], "materials": []}
    bins: list[bytes] = []
    binlen = 0
    ident: dict[tuple, int] = {}
    keys: list[str] = []
    mat_idx: dict[str, int] = {}
    direct: dict[int, list[int]] = {}  # nodo -> mesh posate direttamente (da uno o piu' processi)
    solidkids: set[int] = set()  # nodi con figli senza chiave (parte scomposta in solidi)
    tri = 0

    def add_child(parent: int, idx: int) -> None:
        if parent < 0:
            res["scenes"][0]["nodes"].append(idx)
        else:
            res["nodes"][parent].setdefault("children", []).append(idx)

    for wi, p in enumerate(paths):
        if not os.path.isfile(p):
            continue
        js, b = _read_glb(p)
        pad = (-binlen) % 4
        if pad:
            bins.append(b"\0" * pad)
            binlen += pad
        base_bv, base_acc, base_mesh = len(res["bufferViews"]), len(res["accessors"]), len(res["meshes"])
        for bv in js.get("bufferViews", []):
            bv = dict(bv)
            bv["buffer"] = 0
            bv["byteOffset"] = bv.get("byteOffset", 0) + binlen
            res["bufferViews"].append(bv)
        bins.append(b)
        binlen += len(b)
        for a in js.get("accessors", []):
            a = dict(a)
            if "bufferView" in a:
                a["bufferView"] += base_bv
            res["accessors"].append(a)
        mmap = {}
        for i, m in enumerate(js.get("materials", [])):
            m = {k: v for k, v in m.items() if k not in ("extensions",)}
            pbr = m.get("pbrMetallicRoughness")
            if pbr:
                pbr = {k: v for k, v in pbr.items() if not k.endswith("Texture")}
                m["pbrMetallicRoughness"] = pbr
            for k in [k for k in m if k.endswith("Texture")]:
                m.pop(k)
            s = json.dumps(m, sort_keys=True)
            if s not in mat_idx:
                mat_idx[s] = len(res["materials"])
                res["materials"].append(m)
            mmap[i] = mat_idx[s]
        for me in js.get("meshes", []):
            prims = []
            for pr in me.get("primitives", []):
                pr = dict(pr)
                pr["attributes"] = {k: v + base_acc for k, v in pr["attributes"].items()}
                if "indices" in pr:
                    pr["indices"] += base_acc
                    tri += res["accessors"][pr["indices"]].get("count", 0) // 3
                if "material" in pr:
                    pr["material"] = mmap.get(pr["material"], pr["material"])
                pr.pop("targets", None)
                prims.append(pr)
            res["meshes"].append({"name": me.get("name", "").split(SEP)[-1], "primitives": prims})
        nodes = js.get("nodes", [])

        def visit(ni: int, parent: int, seen: set) -> None:
            if ni in seen:
                return
            seen.add(ni)
            n = nodes[ni]
            raw = n.get("name", "")
            key, _, nm = raw.partition(SEP) if SEP in raw else ("", "", raw)
            idk = (parent, key or f"#{wi}#{ni}")  # nodi senza chiave (solidi di una parte scomposta): mai uniti
            o = ident.get(idk)
            if o is None:
                o = len(res["nodes"])
                if (not nm or nm in GENERIC) and parent >= 0:  # "SOLID", "COMPOUND"...: nome della parte
                    nm = res["nodes"][parent].get("name", nm)
                on = {"name": nm}
                for f in ("matrix", "translation", "rotation", "scale"):
                    if f in n:
                        on[f] = n[f]
                res["nodes"].append(on)
                keys.append(key)
                ident[idk] = o
                add_child(parent, o)
            if "mesh" in n:
                direct.setdefault(o, []).append(n["mesh"] + base_mesh)
            if not key and parent >= 0:
                solidkids.add(parent)
            for c in n.get("children", []):
                visit(c, o, seen)

        sc = js.get("scenes", [{}])[js.get("scene", 0)] if js.get("scenes") else {"nodes": list(range(len(nodes)))}
        seen: set = set()
        for r in sc.get("nodes", []):
            visit(r, -1, seen)
    # geometria posata direttamente su un nodo: se la stessa parte altrove e' scomposta in solidi (in quel processo aveva
    # un solo solido), diventa un figlio come gli altri; se no (solido diviso per facce tra i processi) il primo pezzo
    # resta sul nodo e gli altri sono figli "frammento", che nell'interfaccia selezionano la parte intera
    for o, meshes in direct.items():
        on = res["nodes"][o]
        if o in solidkids:
            todo = meshes
        else:
            on["mesh"] = meshes[0]
            todo = meshes[1:]
        for m in todo:
            c = len(res["nodes"])
            child = {"name": on["name"], "mesh": m}
            if o not in solidkids:
                child["extras"] = {"mbvFrammento": 1}
            res["nodes"].append(child)
            keys.append("")
            add_child(o, c)
    # ordine originale dei figli (etichette XCAF)
    order = lambda i: _entry_key(keys[i]) if keys[i] else (1 << 31,)  # noqa: E731
    res["scenes"][0]["nodes"].sort(key=order)
    for n in res["nodes"]:
        if "children" in n:
            n["children"].sort(key=order)
    if not res["materials"]:
        res.pop("materials")
    blob = b"".join(bins)
    if blob:
        res["buffers"] = [{"byteLength": len(blob)}]
    jb = json.dumps(res, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    jb += b" " * ((-len(jb)) % 4)
    blob += b"\0" * ((-len(blob)) % 4)
    total = 12 + 8 + len(jb) + (8 + len(blob) if blob else 0)
    with open(out, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(jb), 0x4E4F534A))
        f.write(jb)
        if blob:
            f.write(struct.pack("<II", len(blob), 0x004E4942))
            f.write(blob)
    return {"triangoli": tri, "nodi": len(res["nodes"]), "mesh": len(res["meshes"]), "byte": total}


# ------------------------------------------------------------------------------------------------ processo di lavoro
def _peak_mb() -> int:
    if not IS_WIN:
        return 0
    try:
        class PMC(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong), ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]
        c = PMC()
        c.cb = ctypes.sizeof(PMC)
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = ctypes.c_void_p
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
        ctypes.windll.psapi.GetProcessMemoryInfo(k.GetCurrentProcess(), ctypes.byref(c), c.cb)
        return int(c.PeakWorkingSetSize // 1048576)
    except Exception:  # noqa: BLE001
        return 0


def _parent_alive(pid: int) -> bool:
    if not IS_WIN or not pid:
        return True
    k = ctypes.windll.kernel32
    k.OpenProcess.restype = ctypes.c_void_p
    h = k.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not h:
        return False
    try:
        return k.WaitForSingleObject(ctypes.c_void_p(h), 0) == 0x102  # WAIT_TIMEOUT = ancora vivo
    finally:
        k.CloseHandle(ctypes.c_void_p(h))


def worker(src: str, out: str, status: str, defl_path: str, parent: int, go: str = "") -> int:
    st_p, dfl_p, go_p = Path(status), Path(defl_path), Path(go) if go else None
    tempi: dict[str, float] = {}
    state: dict = {"fase": "import", "tempi": tempi}

    def phase(f: str, **kw) -> None:
        state["fase"] = f
        state.update(kw)
        state["memoria_mb"] = _peak_mb()
        _wjson(st_p, state)

    try:
        phase("import")
        t0 = time.time()
        from OCP.BRep import BRep_Builder
        from OCP.BRepBndLib import BRepBndLib
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.Bnd import Bnd_Box
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.Message import Message_ProgressRange
        from OCP.OCP.collections import IndexedDataMap_TCollection_AsciiString_TCollection_AsciiString as StrMap
        from OCP.OCP.collections import Sequence_TDF_Label as LabelSeq
        from OCP.RWGltf import RWGltf_CafWriter
        from OCP.RWMesh import RWMesh_CoordinateSystem
        from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDF import TDF_Label, TDF_Tool
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopoDS import TopoDS_Compound
        from OCP.XCAFDoc import XCAFDoc_DocumentTool
        tempi["import"] = time.time() - t0

        while go_p and not go_p.is_file():  # il file della parte e' pronto
            if not _parent_alive(parent):
                return 3
            time.sleep(0.05)
        if go_p and go_p.read_text(encoding="utf-8").strip() == "esci":
            return 0
        phase("lettura")
        t1 = time.time()
        doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
        ext = Path(src).suffix.lower()
        if ext in (".igs", ".iges"):
            from OCP.IGESCAFControl import IGESCAFControl_Reader
            r = IGESCAFControl_Reader()
            r.SetColorMode(True)
            r.SetNameMode(True)
            r.SetLayerMode(False)
        else:
            from OCP.Interface import Interface_Static
            from OCP.STEPCAFControl import STEPCAFControl_Reader
            r = STEPCAFControl_Reader()
            Interface_Static.SetIVal_s("read.stepcaf.subshapes.name", 1)  # nomi dei singoli solidi
            r.SetColorMode(True)
            r.SetNameMode(True)
            for m in ("SetLayerMode", "SetPropsMode", "SetGDTMode", "SetMatMode", "SetViewMode"):
                getattr(r, m)(False)
        if r.ReadFile(src) != IFSelect_RetDone:
            raise RuntimeError("ReadFile")
        tempi["lettura"] = time.time() - t1
        phase("trasferimento")
        t1 = time.time()
        if not r.Transfer(doc):
            raise RuntimeError("Transfer")
        tempi["trasferimento"] = time.time() - t1

        st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

        def entry(lab) -> str:
            a = TCollection_AsciiString()
            TDF_Tool.Entry_s(lab, a)
            return a.ToCString()

        def name(lab) -> str:
            n = TDataStd_Name()
            if lab.FindAttribute(TDataStd_Name.GetID_s(), n):
                return n.Get().ToExtString()
            return ""

        # etichette delle parti, degli assiemi e delle istanze: il nome diventa "<etichetta> SEP <nome>" (chiave per
        # unire i GLB dei processi); le istanze senza nome prendono quello del prodotto
        labs = LabelSeq()
        st.GetShapes(labs)
        todo = []
        sig = hashlib.sha1()
        for i in range(1, labs.Length() + 1):
            lab = labs.Value(i)
            todo.append((lab, name(lab)))
            if st.IsAssembly_s(lab):
                comps = LabelSeq()
                st.GetComponents_s(lab, comps, False)
                for j in range(1, comps.Length() + 1):
                    c = comps.Value(j)
                    nm = name(c)
                    if not nm or nm.startswith("=>["):
                        ref = TDF_Label()
                        if st.GetReferredShape_s(c, ref):
                            nm = name(ref)
                    todo.append((c, nm))
        for lab, nm in todo:
            e = entry(lab)
            sig.update(f"{e}|{nm}\n".encode("utf-8", "replace"))
            TDataStd_Name.Set_s(lab, TCollection_ExtendedString(e + SEP + nm))
        # parti con piu' solidi: diventano assiemi con un componente per solido (selezionabili uno per uno, come nel
        # lettore dell'interfaccia). Nelle parti divise un solido escluso e' un punto: una parte con un solo solido ha
        # sempre un solo elemento, una con piu' solidi ne ha sempre piu' di uno, in tutti i processi
        from OCP.TopAbs import TopAbs_COMPOUND
        from OCP.TopoDS import TopoDS_Iterator
        for i in range(1, labs.Length() + 1):
            lab = labs.Value(i)
            if st.IsAssembly_s(lab):
                continue
            shp = st.GetShape_s(lab)
            if shp.IsNull() or shp.ShapeType() != TopAbs_COMPOUND:
                continue
            it, k = TopoDS_Iterator(shp), 0
            while it.More() and k < 2:
                k += 1
                it.Next()
            if k >= 2 and st.Expand(lab):
                # i componenti nuovi (anche annidati: compound dentro compound) non hanno chiave, perche' sono diversi
                # in ogni processo: nome del solido se il file lo da', altrimenti quello della parte
                def rename(asm, pn: str, depth: int = 0) -> None:
                    comps = LabelSeq()
                    st.GetComponents_s(asm, comps, False)
                    for j in range(1, comps.Length() + 1):
                        c, ref = comps.Value(j), TDF_Label()
                        has_ref = st.GetReferredShape_s(c, ref)
                        nm = name(ref) if has_ref else ""
                        if not nm or nm.startswith("=>[") or nm in GENERIC:
                            nm = pn
                        TDataStd_Name.Set_s(c, TCollection_ExtendedString(nm))
                        if has_ref and depth < 8 and st.IsAssembly_s(ref):
                            if name(ref) in GENERIC or not name(ref):
                                TDataStd_Name.Set_s(ref, TCollection_ExtendedString(nm))
                            rename(ref, nm, depth + 1)

                rename(lab, name(lab).partition(SEP)[2])

        free = LabelSeq()
        st.GetFreeShapes(free)
        comp = TopoDS_Compound()
        bb = BRep_Builder()
        bb.MakeCompound(comp)
        for i in range(1, free.Length() + 1):
            bb.Add(comp, st.GetShape_s(free.Value(i)))
        box = Bnd_Box()
        BRepBndLib.Add_s(comp, box)
        bbox = None
        if not box.IsVoid():
            p0, p1 = box.CornerMin(), box.CornerMax()
            bbox = [p0.X(), p0.Y(), p0.Z(), p1.X(), p1.Y(), p1.Z()]
        phase("ingombro", bbox=bbox, impronta=sig.hexdigest())
        while not dfl_p.is_file():  # freccia comune decisa dall'app con l'ingombro di tutte le parti
            if not _parent_alive(parent):
                return 3
            time.sleep(0.05)
        defl = float(dfl_p.read_text(encoding="utf-8"))
        phase("triangolazione", freccia=defl)
        t1 = time.time()
        BRepMesh_IncrementalMesh(comp, defl, False, 0.5, os.environ.get("MBV_STEP_MESH_PAR", "1") == "1")
        tempi["triangolazione"] = time.time() - t1
        phase("glb")
        t1 = time.time()
        w = RWGltf_CafWriter(TCollection_AsciiString(out), True)
        cs = w.ChangeCoordinateSystemConverter()
        cs.SetInputLengthUnit(0.001)
        cs.SetOutputLengthUnit(0.001)  # millimetri e Z in alto, come il lettore dell'interfaccia
        cs.SetInputCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup)
        cs.SetOutputCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup)
        w.SetMergeFaces(True)
        if not w.Perform(doc, StrMap(), Message_ProgressRange()):
            raise RuntimeError("GLB")
        tempi["glb"] = time.time() - t1
        phase("fine")
        return 0
    except Exception as e:  # noqa: BLE001
        state["errore"] = f"{e.__class__.__name__}: {e}"
        try:
            _wjson(st_p, state)
        except OSError:
            pass
        return 1


def cli(argv: list[str]) -> int:
    i = argv.index("--step-worker")
    a = argv[i + 1:]
    return worker(a[0], a[1], a[2], a[3], int(a[4]) if len(a) > 4 else 0, a[5] if len(a) > 5 else "")


if __name__ == "__main__":
    if "--step-worker" in sys.argv:
        sys.exit(cli(sys.argv))
    # prova: python -m mbvisual.stepnative <file.step>
    import pprint
    pprint.pprint(convert(sys.argv[1], lambda p=None, m=None: print(f"{(p or 0) * 100:5.1f}% {m or ''}", flush=True)))
