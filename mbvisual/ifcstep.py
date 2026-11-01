"""IFC -> STEP nel motore: IfcOpenShell (LGPL-3.0) legge la geometria esatta, OpenCascade (OCP) e un piccolo scrittore
proprio scrivono lo STEP. Usato dalla conversione a lotti e da "Salva con nome" del visualizzatore 3D.

Perche' qui e non nella pagina: la pagina (web-ifc + three.js) esportava triangoli raccolti in una stringa sola (si fermava
oltre ~0,5-1 GB) e la conversione dipendeva dalla finestra aperta (45 s / 30 min). Qui:
1. processo di LETTURA (`--ifcstep read`): IfcOpenShell apre l'IFC, ricava la struttura (progetto/sito/edificio/piano/
   elemento, anche elementi composti), percorre la geometria in parallelo (aperture sottratte, istanze, Brep, sweep, CSG,
   coordinate del progetto) e scrive le forme B-rep in BLOCCHI su disco (~BLOCCO_MB di dati ciascuno). Gli elementi che
   IfcOpenShell non riesce a calcolare si riprovano senza sottrazione delle aperture, poi come mesh; quelli rimasti
   finiscono nel rapporto con il motivo.
2. processi di SCRITTURA (`--ifcstep write`, quanti la memoria consente): per ogni blocco i solidi a facce piane e lati
   dritti (la quasi totalita' negli IFC) si scrivono come FACETED_BREP (esatti, ~5 volte piu' leggeri), gli altri
   (cilindri, B-spline...) con STEPCAFControl di OpenCascade (superfici esatte, nomi, colori).
3. UNIONE in streaming: i pezzi si rinumerano e si copiano nel file finale, poi si aggiunge l'albero dell'assieme.
   Nessuna stringa intera in memoria: funziona anche con STEP di molti GB.
Unita': millimetri. Coordinate: quelle del progetto (le stesse di Revit/Navisworks).
Insidie: OCP e IfcOpenShell si importano solo nei processi di lavoro (pesanti), mai nell'app. Un processo che va in crash su
un elemento si riavvia saltando quell'elemento (rapporto: "crash").
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

from .i18n import t
from .paths import NO_WINDOW, TEMP_DIR

VERSION = "1"
BLOCCO_MB = 24  # dati B-rep per blocco: ~1,2 GB di memoria per il processo di scrittura nel caso peggiore
SEW_MAX = 5000  # oltre queste facce sciolte non si cuciono in solidi (lento e a rischio di crash)
GRIGIO = [0.75, 0.75, 0.75, 1.0]  # colore degli elementi senza stile
TAG = "@@MBD "  # righe di protocollo sull'uscita dei processi (OpenCascade scrive altro testo sulla stessa uscita)
EXCLUDE = ("IfcOpeningElement", "IfcOpeningStandardCase", "IfcSpace", "IfcSpatialZone", "IfcVirtualElement")
BODY_IDS = ("body", "facetation", "body-fallback", "mesh", "surface")  # rappresentazioni 3D che contano come geometria
CURVE_TYPES = ("curve", "curve2d", "curve3d", "geometriccurveset", "geometricset", "point", "pointcloud", "annotation2d")


def available() -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec("OCP") is not None and importlib.util.find_spec("ifcopenshell") is not None
    except Exception:  # noqa: BLE001
        return False


def _cmd(*args) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--ifcstep", *args]
    return [sys.executable, "-m", "mbvisual.ifcstep", *args]


def _mem() -> tuple[int, int]:
    from .stepnative import _mem_bytes
    return _mem_bytes()


def _sx(s) -> str:
    """Stringa STEP: apostrofi e barre raddoppiati, caratteri non ASCII in \\X2\\....\\X0\\ (o \\X4\\ oltre il piano base)."""
    out = []
    for ch in str(s or ""):
        c = ord(ch)
        if ch == "'":
            out.append("''")
        elif ch == "\\":
            out.append("\\\\")
        elif 32 <= c < 127:
            out.append(ch)
        elif c < 0x10000:
            out.append("\\X2\\%04X\\X0\\" % c)
        elif c < 0x110000:
            out.append("\\X4\\%08X\\X0\\" % c)
    return "'" + "".join(out) + "'"


def _num(x: float, d: int = 6) -> str:
    """Numero reale STEP (sempre con il punto) a d decimali: millimetri a 6 decimali = un milionesimo di mm."""
    s = ("%.*f" % (d, x)).rstrip("0")
    return "0." if s in ("-.", "-0.", "0.", ".") else s


# ================================================================================================= conversione (app)
class _Fail(RuntimeError):
    pass


class Cancel(Exception):
    """Interruzione chiesta da chi ha avviato la conversione."""


def convert(src: str, out: str, update=None, cancelled=None) -> dict:
    """IFC -> STEP (mm). Restituisce il rapporto {attesi, convertiti, esatti, ripiego, falliti: [...], dimensione, tempo}."""
    update = update or (lambda *a, **k: None)
    cancelled = cancelled or (lambda: False)
    if not available():
        raise RuntimeError(t("srv_ifcstep.non_disponibile"))
    t0 = time.time()
    k = hashlib.sha1(f"{os.path.abspath(src)}|{time.time()}|{os.getpid()}".encode()).hexdigest()[:16]
    work = TEMP_DIR / "ifcstep" / k
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    try:
        return _convert(src, out, work, update, cancelled, t0)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _writers_for() -> int:
    if os.environ.get("MBV_IFCSTEP_PROCESSI"):
        return max(1, int(os.environ["MBV_IFCSTEP_PROCESSI"]))
    total, free = _mem()
    cores = os.cpu_count() or 4
    # ~1,4 GB per processo di scrittura nel caso peggiore (blocco tutto di superfici curve); il lettore resta acceso
    return max(1, min(cores - 1, int(max(free, total * 0.3) / (1.4 * 1024 ** 3)), 6))


class _Proc:
    """Processo di lavoro con le righe di protocollo lette in un thread."""

    def __init__(self, args: list[str], on_line, stdin=False):
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, creationflags=NO_WINDOW, cwd=str(Path(__file__).resolve().parent.parent),
                                  env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"})
        self.tail: list[str] = []
        self.th = threading.Thread(target=self._read, args=(on_line,), daemon=True)
        self.th.start()

    def _read(self, on_line):
        for raw in self.p.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith(TAG):
                on_line(self, line[len(TAG):])
            elif line.strip():
                self.tail = (self.tail + [line])[-20:]

    def send(self, s: str):
        self.p.stdin.write((s + "\n").encode("utf-8"))
        self.p.stdin.flush()

    def kill(self):
        try:
            self.p.kill()
        except OSError:
            pass


def _convert(src, out, work: Path, update, cancelled, t0) -> dict:
    lock = threading.Lock()
    st = {"p": 0.0, "chunks": [], "read_done": False, "read_err": None, "struct": None, "el": None}
    results: dict[int, dict] = {}  # blocco -> risultato del processo di scrittura
    queue: list[tuple[int, list]] = []  # (blocco, elementi da saltare)
    skips: dict[int, set] = {}
    tries: dict[int, int] = {}

    def on_read(_p, line):
        cmd, _, rest = line.partition(" ")
        with lock:
            if cmd == "p":
                st["p"] = float(rest)
            elif cmd == "chunk":
                i = len(st["chunks"])
                st["chunks"].append(rest)
                queue.append((i, []))
            elif cmd == "done":
                st["struct"] = rest
            elif cmd == "err":
                st["read_err"] = rest

    reader = _Proc(_cmd("read", src, str(work)), on_read)
    writers: list[dict] = []

    def on_write(proc, line):
        cmd, _, rest = line.partition(" ")
        with lock:
            w = next(x for x in writers if x["proc"] is proc)
            if cmd == "el":
                w["el"] = rest
            elif cmd == "ok":
                results[w["job"]] = json.loads(rest)
                w["job"] = None
                w["el"] = None

    nmax = _writers_for()

    def spawn():
        w = {"proc": None, "job": None, "el": None}
        writers.append(w)
        w["proc"] = _Proc(_cmd("write"), on_write, stdin=True)
        return w

    total_chunks = None
    try:
        while True:
            if cancelled():
                raise Cancel()
            with lock:
                read_alive = reader.p.poll() is None
                if not read_alive and not st["read_done"]:
                    st["read_done"] = True
                    if reader.p.returncode != 0 or not st["struct"]:
                        msg = st["read_err"] or "\n".join(reader.tail[-5:]) or f"codice {reader.p.returncode}"
                        raise _Fail(t("srv_ifcstep.lettura_fallita", msg))
                    total_chunks = len(st["chunks"])
                # processi di scrittura: crash -> si salta l'elemento in corso e si rifa' il blocco
                for w in list(writers):
                    if w["proc"].p.poll() is not None:
                        writers.remove(w)
                        if w["job"] is not None:
                            j = w["job"]
                            tries[j] = tries.get(j, 0) + 1
                            if w["el"] is not None:
                                skips.setdefault(j, set()).add(w["el"])
                            if tries[j] > 40:
                                raise _Fail(t("srv_ifcstep.scrittura_fallita", "\n".join(w["proc"].tail[-5:])))
                            queue.insert(0, (j, sorted(skips.get(j, ()))))
                # assegna i blocchi pronti
                while queue:
                    idle = next((w for w in writers if w["job"] is None), None)
                    if idle is None and len(writers) < nmax:
                        idle = spawn()
                    if idle is None:
                        break
                    j, skip = queue.pop(0)
                    idle["job"] = j
                    idle["el"] = None
                    idle["proc"].send(json.dumps({"in": st["chunks"][j], "out": str(work / f"b{j:05d}"), "skip": skip}))
                done = len(results)
                if total_chunks is not None and done >= total_chunks:
                    break
                pr = st["p"]
            n = total_chunks if total_chunks is not None else max(len(st["chunks"]), 1)
            update(0.02 + 0.55 * pr + 0.33 * (done / max(n, 1)) * (1 if total_chunks is not None else pr),
                  t("srv_ifcstep.avanzamento", done, n if total_chunks is not None else "?"))
            time.sleep(0.15)
    finally:
        for w in writers:
            try:
                w["proc"].p.stdin.close()
            except OSError:
                pass
        for w in writers:
            try:
                w["proc"].p.wait(5)
            except subprocess.TimeoutExpired:
                w["proc"].kill()
        if reader.p.poll() is None:
            reader.kill()
    struct_info = json.loads(Path(st["struct"]).read_text(encoding="utf-8"))
    if not total_chunks or not any(r.get("fac_path") or r.get("occ_path") for r in results.values()):
        raise _Fail(t("srv_ifcstep.nessuna_geometria"))
    update(0.9, t("srv_ifcstep.unione"))
    rep = _merge(out, struct_info, [results[i] for i in range(total_chunks)], work, src, update)
    names = {int(k): v for k, v in struct_info["nodes"].items()}
    falliti = list(struct_info.get("falliti", []))
    for el in rep.pop("persi", []):
        nd = names.get(el, {})
        falliti.append({"g": nd.get("g", ""), "n": nd.get("n", ""), "c": nd.get("c", ""), "motivo": t("srv_ifcstep.geometria_non_scritta")})
    for r in results.values():  # (gli elementi saltati dopo un crash li riporta il blocco rifatto)
        for e in r.get("falliti", []):
            nd = names.get(e["id"], {})
            falliti.append({"g": nd.get("g", ""), "n": nd.get("n", ""), "c": nd.get("c", ""), "motivo": e.get("motivo", "")})
    conv = rep.pop("elementi")
    rep.update({
        "attesi": struct_info["attesi"], "convertiti": conv, "falliti": falliti,
        "facce_piane": sum(r.get("fac", 0) for r in results.values()), "superfici": sum(r.get("occ", 0) for r in results.values()),
        "mesh": sum(r.get("mesh", 0) for r in results.values()), "ripiego": struct_info.get("ripiego", 0),
        "approssimati": struct_info.get("approssimati", []),
        "solo_linee": struct_info.get("solo_linee", 0) + sum(r.get("linee", 0) for r in results.values()), "tempo": round(time.time() - t0, 1), "dimensione": os.path.getsize(out),
        "blocchi": total_chunks, "processi": nmax,
    })
    update(1.0, "")
    return rep


# ================================================================================================= unione in streaming
_RE_REF = re.compile(rb"#(\d+)")
_RE_GLOB = re.compile(rb"@(\d+)")
_RE_PROD = re.compile(rb"#(\d+)\s*=\s*PRODUCT\(\s*'MBD([EG])(\d+)',\s*'MBD[EG]\d+',\s*'',")
_RE_PDF = re.compile(rb"#(\d+) = PRODUCT_DEFINITION_FORMATION\(\s*'',\s*'',\s*#(\d+)\s*\)")
_RE_PD = re.compile(rb"#(\d+) = PRODUCT_DEFINITION\(\s*'design',\s*'',\s*#(\d+),")
_RE_PDS = re.compile(rb"#(\d+) = PRODUCT_DEFINITION_SHAPE\(\s*'',\s*'',\s*#(\d+)\s*\)")
_RE_SDR = re.compile(rb"#(\d+) = SHAPE_DEFINITION_REPRESENTATION\(\s*#(\d+),\s*#(\d+)\s*\)")

# entita' globali scritte all'inizio con numeri fissi (i pezzi a facce piane le citano come @n)
G_APP, G_APD, G_PCTX, G_PDCTX, G_UL, G_UA, G_US, G_UNC, G_GCTX, G_O, G_Z, G_X, G_AX = range(1, 14)
GLOBAL = [
    "APPLICATION_CONTEXT('core data for automotive mechanical design processes')",
    f"APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#{G_APP})",
    f"PRODUCT_CONTEXT('',#{G_APP},'mechanical')",
    f"PRODUCT_DEFINITION_CONTEXT('part definition',#{G_APP},'design')",
    "(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))",
    "(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))",
    "(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())",
    f"UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#{G_UL},'distance_accuracy_value','confusion accuracy')",
    f"(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#{G_UNC}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#{G_UL},#{G_UA},#{G_US}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))",
    "CARTESIAN_POINT('',(0.,0.,0.))", "DIRECTION('',(0.,0.,1.))", "DIRECTION('',(1.,0.,0.))",
    f"AXIS2_PLACEMENT_3D('',#{G_O},#{G_Z},#{G_X})",
]


def _merge(out: str, info: dict, chunks: list[dict], work: Path, src: str, update) -> dict:
    nodes = {int(k): v for k, v in info["nodes"].items()}
    gnames = info.get("geometrie") or []
    tmp = out + ".mbv-tmp"
    prods: dict[int, tuple[int, int]] = {}  # elemento -> (PRODUCT_DEFINITION, rappresentazione) nel file finale
    gfac: dict[int, tuple[int, int]] = {}  # geometria condivisa a facce piane -> (rappresentazione, asse)
    gocc: dict[int, tuple[int, int]] = {}  # geometria condivisa scritta da OpenCascade -> (PRODUCT_DEFINITION, rappr.)
    with open(tmp, "wb", buffering=8 * 1024 * 1024) as fo:
        name = Path(src).stem
        fo.write(("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('MB Desk - IFC -> STEP'),'2;1');\n"
                  f"FILE_NAME({_sx(name + '.stp')},'{time.strftime('%Y-%m-%dT%H:%M:%S')}',(''),(''),'MB Desk','MB Desk','');\n"
                  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n").encode("ascii"))
        for i, g in enumerate(GLOBAL, 1):
            fo.write(f"#{i}={g};\n".encode("ascii"))
        nid = len(GLOBAL)
        total = len(chunks)
        for ci, r in enumerate(chunks):
            update(0.9 + 0.08 * ci / max(total, 1), t("srv_ifcstep.unione"))
            if r.get("fac_path"):
                nid = _copy_part(fo, r["fac_path"], nid, prods, gocc, nodes, gnames, faceted=r.get("fac_map") or {}, gfac=gfac)
            if r.get("occ_path"):
                nid = _copy_part(fo, r["occ_path"], nid, prods, gocc, nodes, gnames)
        nid, persi = _write_instances(fo, info, nodes, prods, gfac, gocc, nid)
        nid = _write_tree(fo, info, nodes, prods, nid)
        fo.write(b"ENDSEC;\nEND-ISO-10303-21;\n")
    os.replace(tmp, out)
    return {"entita": nid, "persi": persi, "elementi": len(prods)}


def _copy_part(fo, path: str, off: int, prods: dict, gocc: dict, nodes: dict, gnames: list, faceted: dict | None = None,
               gfac: dict | None = None) -> int:
    """Copia un pezzo rinumerando le entita' (#n -> #n+off; @n -> #n globali). Restituisce il nuovo ultimo numero."""
    mx = [0]

    def ren(m):
        v = int(m.group(1))
        if v > mx[0]:
            mx[0] = v
        return b"#%d" % (v + off)

    def prod(m):
        k = int(m.group(3))
        if m.group(2) == b"G":  # geometria condivisa: il nome del primo elemento che la usa
            nm = gnames[k] if k < len(gnames) else "IFC"
            return f"#{m.group(1).decode()}=PRODUCT({_sx(nm)},{_sx(nm)},'',".encode("ascii")
        nd = nodes.get(k, {})
        nm = nd.get("n") or nd.get("c") or "IFC"
        return (f"#{m.group(1).decode()}=PRODUCT({_sx(nd.get('g') or nm)},{_sx(nm)},{_sx(nd.get('c', ''))},").encode("ascii")

    pdf2prod, pd2pdf, pds2pd, sdr = {}, {}, {}, []
    tokens: dict[int, tuple[bytes, int]] = {}
    with open(path, "rb") as fi:
        in_data = faceted is not None
        rest = b""
        while True:
            blk = fi.read(16 * 1024 * 1024)
            if not blk and not rest:
                break
            buf = rest + blk
            if blk:
                cut = buf.rfind(b";\n")
                if cut < 0:
                    rest = buf
                    continue
                rest, buf = buf[cut + 2:], buf[:cut + 2]
            else:
                rest = b""
            if not in_data:  # pezzo di OpenCascade: si salta l'intestazione
                k = buf.find(b"\nDATA;\n")
                if k < 0:
                    continue
                buf = buf[k + 7:]
                in_data = True
            e = buf.find(b"\nENDSEC;")
            if e >= 0 and faceted is None:
                buf = buf[:e + 1]
            buf = _RE_REF.sub(ren, buf)
            if faceted is not None:
                buf = _RE_GLOB.sub(rb"#\1", buf)
                buf = _RE_PROD.sub(prod, buf)
            else:
                for m in _RE_PROD.finditer(buf):
                    tokens[int(m.group(1))] = (m.group(2), int(m.group(3)))
                buf = _RE_PROD.sub(prod, buf)
                for m in _RE_PDF.finditer(buf):
                    pdf2prod[int(m.group(1))] = int(m.group(2))
                for m in _RE_PD.finditer(buf):
                    pd2pdf[int(m.group(1))] = int(m.group(2))
                for m in _RE_PDS.finditer(buf):
                    pds2pd[int(m.group(1))] = int(m.group(2))
                for m in _RE_SDR.finditer(buf):
                    sdr.append((int(m.group(2)), int(m.group(3))))
            fo.write(buf)
            if e >= 0 and faceted is None:
                break
    if faceted is not None:
        for el, (pd, sr) in (faceted.get("els") or {}).items():
            prods[int(el)] = (pd + off, sr + off)
        for gi, (sr, ax) in (faceted.get("geo") or {}).items():
            gfac[int(gi)] = (sr + off, ax + off)
    else:
        for pds, sr in sdr:
            pd = pds2pd.get(pds)
            tok = tokens.get(pdf2prod.get(pd2pdf.get(pd)))
            if tok is None:
                continue
            kind, k = tok
            target = gocc if kind == b"G" else prods
            if k not in target:
                target[k] = (pd, sr)
    return off + mx[0]


def _write_instances(fo, info: dict, nodes: dict, prods: dict, gfac: dict, gocc: dict, nid: int) -> tuple[int, list]:
    """Elementi che usano una geometria condivisa: a facce piane = MAPPED_ITEM della rappresentazione (l'elemento resta
    una parte con il suo nome), altrimenti = assieme con la parte della geometria posizionata."""
    def A(s: str) -> int:
        nonlocal nid
        nid += 1
        fo.write(f"#{nid}={s};\n".encode("ascii"))
        return nid

    def place(m) -> int:
        p = A(f"CARTESIAN_POINT('',({_num(m[12] * 1000)},{_num(m[13] * 1000)},{_num(m[14] * 1000)}))")
        z = A(f"DIRECTION('',({_num(m[8], 12)},{_num(m[9], 12)},{_num(m[10], 12)}))")
        x = A(f"DIRECTION('',({_num(m[0], 12)},{_num(m[1], 12)},{_num(m[2], 12)}))")
        return A(f"AXIS2_PLACEMENT_3D('',#{p},#{z},#{x})")

    def product(el: int, sr: int) -> int:
        nd = nodes.get(el, {})
        nm = nd.get("n") or nd.get("c") or "IFC"
        prod = A(f"PRODUCT({_sx(nd.get('g') or nm)},{_sx(nm)},{_sx(nd.get('c', ''))},(#{G_PCTX}))")
        A(f"PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#{prod}))")
        pdf = A(f"PRODUCT_DEFINITION_FORMATION('','',#{prod})")
        pd = A(f"PRODUCT_DEFINITION('design','',#{pdf},#{G_PDCTX})")
        A(f"SHAPE_DEFINITION_REPRESENTATION(#{A(f'PRODUCT_DEFINITION_SHAPE({chr(39)}{chr(39)},{chr(39)}{chr(39)},#{pd})')},#{sr})")
        return pd

    rmaps: dict[int, int] = {}
    persi = []
    uses: dict[int, int] = {}
    for _el, gi, _m in info.get("istanze") or []:
        uses[gi] = uses.get(gi, 0) + 1
    gnames = info.get("geometrie") or []
    for gi, (gsr, gax) in list(gfac.items()):
        # geometria a facce piane usata da piu' elementi: parte propria, richiamata da ogni elemento (assieme con il suo
        # nome); con MAPPED_ITEM i lettori come OpenCascade uniscono le forme identiche e i nomi degli elementi si perdono
        if uses.get(gi, 0) > 1:
            nm = gnames[gi] if gi < len(gnames) else "IFC"
            prod = A(f"PRODUCT({_sx(nm)},{_sx(nm)},'',(#{G_PCTX}))")
            A(f"PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#{prod}))")
            pd = A(f"PRODUCT_DEFINITION('design','',#{A(f'PRODUCT_DEFINITION_FORMATION({chr(39)}{chr(39)},{chr(39)}{chr(39)},#{prod})')},#{G_PDCTX})")
            A(f"SHAPE_DEFINITION_REPRESENTATION(#{A(f'PRODUCT_DEFINITION_SHAPE({chr(39)}{chr(39)},{chr(39)}{chr(39)},#{pd})')},#{gsr})")
            gocc[gi] = (pd, gsr, gax)
            del gfac[gi]
    for el, gi, m in info.get("istanze") or []:
        if el in prods:
            continue
        if gi in gfac:
            gsr, gax = gfac[gi]
            if gi not in rmaps:
                rmaps[gi] = A(f"REPRESENTATION_MAP(#{gax},#{gsr})")
            mi = A(f"MAPPED_ITEM('',#{rmaps[gi]},#{place(m)})")
            sr = A(f"SHAPE_REPRESENTATION('',(#{mi},#{G_AX}),#{G_GCTX})")
            prods[el] = (product(el, sr), sr)
        elif gi in gocc:
            gpd, gsr = gocc[gi][:2]
            gax = gocc[gi][2] if len(gocc[gi]) > 2 else G_AX
            tgt = place(m)
            sr = A(f"SHAPE_REPRESENTATION('',(#{G_AX},#{tgt}),#{G_GCTX})")
            pd = product(el, sr)
            nd = nodes.get(el, {})
            nauo = A(f"NEXT_ASSEMBLY_USAGE_OCCURRENCE('g{gi}',{_sx(nd.get('n') or nd.get('c') or '')},'',#{pd},#{gpd},$)")
            idt = A(f"ITEM_DEFINED_TRANSFORMATION('','',#{gax},#{tgt})")
            rel = A(f"(REPRESENTATION_RELATIONSHIP('','',#{gsr},#{sr})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#{idt})SHAPE_REPRESENTATION_RELATIONSHIP())")
            A(f"CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#{rel},#{A(f'PRODUCT_DEFINITION_SHAPE({chr(39)}{chr(39)},{chr(39)}{chr(39)},#{nauo})')})")
            prods[el] = (pd, sr)
        else:
            persi.append(el)
    return nid, persi


def _write_tree(fo, info: dict, nodes: dict, prods: dict, nid: int) -> int:
    """Albero dell'assieme: progetto -> sito -> edificio -> piano -> elemento (-> parti degli elementi composti)."""
    def A(s: str) -> int:
        nonlocal nid
        nid += 1
        fo.write(f"#{nid}={s};\n".encode("ascii"))
        return nid

    children: dict[int, list[int]] = {}
    roots = []
    for el in prods:
        children.setdefault(el, [])
    # catena dei genitori di ogni elemento convertito
    need = set(prods)
    for el in list(prods):
        p = nodes.get(el, {}).get("p")
        seen = 0
        while p is not None and seen < 64:
            need.add(p)
            p = nodes.get(p, {}).get("p")
            seen += 1
    for n in need:
        p = nodes.get(n, {}).get("p")
        if p is not None and p in need:
            children.setdefault(p, []).append(n)
        else:
            roots.append(n)
    for v in children.values():
        v.sort(key=lambda c: (nodes.get(c, {}).get("o", 0), c))

    def assembly(n: int, label: str | None = None):
        nd = nodes.get(n, {})
        nm = label or nd.get("n") or nd.get("c") or "IFC"
        prod = A(f"PRODUCT({_sx(nd.get('g') or nm)},{_sx(nm)},{_sx(nd.get('c', ''))},(#{G_PCTX}))")
        A(f"PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#{prod}))")
        pdf = A(f"PRODUCT_DEFINITION_FORMATION('','',#{prod})")
        pd = A(f"PRODUCT_DEFINITION('design','',#{pdf},#{G_PDCTX})")
        pds = A(f"PRODUCT_DEFINITION_SHAPE('','',#{pd})")
        ax = A(f"AXIS2_PLACEMENT_3D('',#{G_O},#{G_Z},#{G_X})")
        sr = A(f"SHAPE_REPRESENTATION({_sx(nm)},(#{ax}),#{G_GCTX})")
        A(f"SHAPE_DEFINITION_REPRESENTATION(#{pds},#{sr})")
        return pd, sr, ax

    k = [0]

    def link(parent: tuple, child_pd: int, child_sr: int, nm: str):
        k[0] += 1
        ppd, psr, pax = parent
        nauo = A(f"NEXT_ASSEMBLY_USAGE_OCCURRENCE('{k[0]}',{_sx(nm)},'',#{ppd},#{child_pd},$)")
        cax = A(f"AXIS2_PLACEMENT_3D('',#{G_O},#{G_Z},#{G_X})")
        idt = A(f"ITEM_DEFINED_TRANSFORMATION('','',#{cax},#{pax})")
        rel = A(f"(REPRESENTATION_RELATIONSHIP('','',#{child_sr},#{psr})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#{idt})SHAPE_REPRESENTATION_RELATIONSHIP())")
        A(f"CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#{rel},#{A(f'PRODUCT_DEFINITION_SHAPE({chr(39)}{chr(39)},{chr(39)}{chr(39)},#{nauo})')})")

    def build(n: int) -> tuple[int, int]:
        """(PRODUCT_DEFINITION, rappresentazione) del nodo: un elemento senza parti e' il suo prodotto."""
        kids = children.get(n, [])
        if n in prods and not kids:
            return prods[n]
        me = assembly(n)
        nd = nodes.get(n, {})
        if n in prods:  # elemento composto con geometria propria: la geometria e' una parte con lo stesso nome
            pd, sr = prods[n]
            link(me, pd, sr, nd.get("n") or nd.get("c") or "")
        for c in kids:
            cpd, csr = build(c)
            cn = nodes.get(c, {})
            link(me, cpd, csr, cn.get("n") or cn.get("c") or "")
        return me[0], me[1]

    roots.sort(key=lambda r: (0 if nodes.get(r, {}).get("c", "").upper() == "IFCPROJECT" else 1, r))
    if len(roots) == 1 and children.get(roots[0]):
        build(roots[0])
    else:  # elementi fuori dalla struttura: tutto sotto un prodotto con il nome del file
        top = assembly(-1, info.get("nome") or "IFC")
        for r in roots:
            cpd, csr = build(r)
            rn = nodes.get(r, {})
            link(top, cpd, csr, rn.get("n") or rn.get("c") or "")
    return nid


# ================================================================================================= processo di lettura
def _out(cmd: str, rest="") -> None:
    sys.stdout.write(f"{TAG}{cmd} {rest}\n")
    sys.stdout.flush()


def _is_body(rep) -> bool:
    ctx = rep.ContextOfItems
    try:
        ct = (getattr(ctx, "ContextType", None) or getattr(getattr(ctx, "ParentContext", None), "ContextType", None) or "Model").lower()
    except Exception:  # noqa: BLE001
        ct = "model"
    if ct not in ("model", "design", "model view"):
        return False
    ident = (rep.RepresentationIdentifier or "").lower()
    typ = (rep.RepresentationType or "").lower()
    if typ in CURVE_TYPES:
        return False
    if ident in BODY_IDS:
        return True
    return ident == "" and typ not in ("", "boundingbox")


def _rigid(m) -> bool:
    """Matrice 4x4 (per colonne) di sola rotazione + traslazione: rappresentabile con un AXIS2_PLACEMENT_3D."""
    a = (m[0:3], m[4:7], m[8:11])
    for i in range(3):
        if abs(sum(x * x for x in a[i]) - 1) > 1e-6:
            return False
        for j in range(i + 1, 3):
            if abs(sum(x * y for x, y in zip(a[i], a[j]))) > 1e-6:
                return False
    det = (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[1][0] * (a[0][1] * a[2][2] - a[0][2] * a[2][1])
           + a[2][0] * (a[0][1] * a[1][2] - a[0][2] * a[1][1]))
    return det > 0


_SEC = re.compile(rb"^(Curves|Surfaces) ([0-9]+)[ \t\r]*$", re.M)


def _planar_text(data: bytes) -> bool:
    """Dal testo B-rep di OpenCascade: tutte le curve sono rette (tipo 1) e tutte le superfici piani (tipo 1)?"""
    found = 0
    for m in _SEC.finditer(data):
        n = int(m.group(2))
        pos = data.find(b"\n", m.end()) + 1
        for _ in range(n):
            e = data.find(b"\n", pos)
            if e < 0 or data[pos:pos + 2] != b"1 ":
                return False
            pos = e + 1
        found += 1
    return found == 2


def read_main(src: str, work: str) -> int:
    import multiprocessing
    import ifcopenshell
    import ifcopenshell.geom as geom
    import ifcopenshell.ifcopenshell_wrapper as W
    work_p = Path(work)
    try:
        f = ifcopenshell.open(src)
    except Exception as e:  # noqa: BLE001
        _out("err", t("srv_ifcstep.non_leggibile", str(e)[:300]))
        return 2
    _out("p", "0.02")
    schema = f.schema
    excl = []
    for c in EXCLUDE:
        try:
            f.by_type(c)
            excl.append(c)
        except Exception:  # noqa: BLE001
            pass
    # ---------------------------------------------------------------- struttura
    nodes: dict[int, dict] = {}
    parent: dict[int, int] = {}

    def node(e):
        i = e.id()
        if i not in nodes:
            nm = getattr(e, "Name", None) or getattr(e, "LongName", None) or ""
            nd = {"g": getattr(e, "GlobalId", "") or "", "n": str(nm), "c": e.is_a()}
            if e.is_a("IfcBuildingStorey"):
                try:
                    nd["o"] = float(e.Elevation or 0)
                except (TypeError, ValueError):
                    pass
            nodes[i] = nd
        return i

    for rel in f.by_type("IfcRelAggregates"):
        for o in rel.RelatedObjects or ():
            parent[node(o)] = node(rel.RelatingObject)
    for rel in f.by_type("IfcRelContainedInSpatialStructure"):
        for o in rel.RelatedElements or ():
            parent.setdefault(node(o), node(rel.RelatingStructure))
    for rel in f.by_type("IfcRelNests"):
        try:
            for o in rel.RelatedObjects or ():
                if o.is_a("IfcProduct"):
                    parent.setdefault(node(o), node(rel.RelatingObject))
        except Exception:  # noqa: BLE001
            pass
    # porte e finestre legate solo all'apertura: vanno dove sta l'elemento forato
    try:
        voids = {r.RelatedOpeningElement.id(): r.RelatingBuildingElement.id() for r in f.by_type("IfcRelVoidsElement")}
        for r in f.by_type("IfcRelFillsElement"):
            d = r.RelatedBuildingElement
            host = voids.get(r.RelatingOpeningElement.id())
            if host is not None and node(d) not in parent and host in parent:
                parent[node(d)] = parent[host]
    except Exception:  # noqa: BLE001
        pass
    for p in f.by_type("IfcProject"):
        node(p)
    # elementi attesi = prodotti con una rappresentazione 3D (corpo)
    attesi = {}
    for p in f.by_type("IfcProduct"):
        if any(p.is_a(c) for c in excl) or not p.Representation:
            continue
        try:
            reps = p.Representation.Representations or ()
        except Exception:  # noqa: BLE001
            continue
        if any(_is_body(r) for r in reps):
            attesi[p.id()] = p
            node(p)
    for i, pi in parent.items():
        nodes[i]["p"] = pi
    _out("p", "0.05")
    # ---------------------------------------------------------------- geometria
    W.turn_off_detailed_logging() if hasattr(W, "turn_off_detailed_logging") else None
    try:
        W.set_log_format_json()
    except Exception:  # noqa: BLE001
        pass
    prodotti: set[int] = set()
    solo_linee = 0
    # geometrie a facce piane condivise (istanze IFC: IfcMappedItem, tipi): scritte una volta, gli elementi le richiamano
    geos: dict = {}
    geos_no: set = set()
    geo_names: list[str] = []
    inst: list = []
    chunk = {"f": None, "n": 0, "bytes": 0, "i": 0}

    def close_chunk():
        if chunk["f"]:
            chunk["f"].close()
            _out("chunk", chunk["path"])
            chunk["f"] = None

    def put(el_id: int, kind: int, meta: dict, data: bytes):  # kind 0 = elemento, 3 = geometria condivisa (el_id = indice)
        if chunk["f"] is None:
            chunk["path"] = str(work_p / f"c{chunk['i']:05d}.bin")
            chunk["i"] += 1
            chunk["f"] = open(chunk["path"], "wb")
            chunk["bytes"] = 0
        mb = json.dumps({"id": el_id, **meta}).encode("utf-8")
        chunk["f"].write(struct.pack("<IBQ", len(mb), kind, len(data)) + mb)
        chunk["f"].write(data)
        chunk["bytes"] += len(data)
        if chunk["bytes"] >= BLOCCO_MB * 1024 * 1024:
            close_chunk()

    def styles(geo) -> dict:
        ids = list(geo.surface_style_ids)
        ss = list(geo.surface_styles)
        uq = list(dict.fromkeys(ids))
        cols = []
        for i in range(len(uq)):
            c = ss[i * 4:i * 4 + 4]
            cols.append(None if (len(c) < 4 or c[0] < 0) else [round(x, 4) for x in c])
        return {"ids": [uq.index(i) for i in ids], "cols": cols}

    def handle(sh, meta_extra=None):
        try:
            eid = int(sh.id)
            geo = sh.geometry
            if eid not in prodotti:
                prodotti.add(eid)
                node(f.by_id(eid))
                if eid in parent:
                    nodes[eid]["p"] = parent[eid]
                m = list(sh.transformation.matrix)  # 4x4 per colonne, metri: posizione dell'elemento
                gk = geo.id
                gi = geos.get(gk)
                if gi is not None and _rigid(m):  # geometria gia' scritta: solo la posizione (MAPPED_ITEM)
                    inst.append([eid, gi, m])
                else:
                    ser = W.serialization(geo)  # testo B-rep solo per le geometrie nuove (le copie costano solo la posizione)
                    data = ser.brep_data
                    data = data.encode("utf-8") if isinstance(data, str) else bytes(data)
                    if b"\nFa\n" not in data:
                        # nessuna faccia: per un elemento con corpo 3D e' un calcolo fallito (es. sottrazione delle aperture
                        # che non lascia nulla): si riprova nei ripieghi; senza corpo (linee, assi) si salta
                        prodotti.discard(eid)
                        return
                    meta = {**styles(ser), "att": eid in attesi, "n": nodes[eid]["n"], **(meta_extra or {})}
                    if gk not in geos_no and _rigid(m) and _planar_text(data):
                        gi = geos[gk] = len(geos)
                        geo_names.append(nodes[eid]["n"] or nodes[eid]["c"])
                        put(gi, 3, meta, data)
                        inst.append([eid, gi, m])
                    else:  # superfici curve o posizione con scala/specchio: forma propria (il processo la posiziona)
                        geos_no.add(gk)
                        put(eid, 0, {**meta, "m": m}, data)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"elemento saltato: {e}\n")

    def run(settings, include=None, threads=None, frac=(0.05, 0.95), meta_extra=None):
        kw = {"exclude": tuple(excl)} if include is None else {"include": include}
        it = geom.iterator(settings, f, threads or multiprocessing.cpu_count(), **kw)
        if not it.initialize():
            return
        last = time.time()
        while True:
            handle(it.get(), meta_extra)
            if time.time() - last > 0.5:
                last = time.time()
                _out("p", f"{frac[0] + (frac[1] - frac[0]) * it.progress() / 100:.4f}")
            if not it.next():
                break

    s = geom.settings()
    s.set("iterator-output", W.NATIVE)  # geometria calcolata in parallelo, serializzata qui solo quando serve
    s.set("use-world-coords", False)  # coordinate locali + posizione: le geometrie ripetute si riconoscono e si scrivono una volta
    s.set("apply-default-materials", True)
    run(s)
    # ---------------------------------------------------------------- ripieghi per gli elementi non calcolati
    # ripieghi per gli elementi non calcolati: uno alla volta, prima CON le aperture e tolleranza crescente (profili con
    # curve non perfettamente unite: "Courbes non jointives"), solo alla fine senza sottrarre le aperture
    ripiego = 0
    tentativi = [({"precision-factor": 10.0}, "precisione"), ({"precision-factor": 1000.0}, "precisione"),
                 ({"precision-factor": 1000.0, "disable-opening-subtractions": True}, "aperture"),
                 ({"precision-factor": 1000.0, "disable-boolean-result": True}, "tagli")]
    approssimati = []  # elementi convertiti senza aperture o senza tagli: nel rapporto
    for opts, tag in tentativi:
        mancanti = [attesi[i] for i in attesi if i not in prodotti]
        if not mancanti:
            break
        s2 = geom.settings()
        s2.set("iterator-output", W.NATIVE)
        s2.set("use-world-coords", False)
        s2.set("apply-default-materials", True)
        for k, v in opts.items():
            try:
                s2.set(k, v)
            except Exception:  # noqa: BLE001
                pass
        n0 = len(prodotti)
        for e in mancanti:
            try:
                sh = geom.create_shape(s2, e)
            except Exception:  # noqa: BLE001
                continue
            if sh is not None:
                handle(sh, {"rip": tag})
                if e.id() in prodotti and tag != "precisione":
                    approssimati.append({"g": getattr(e, "GlobalId", ""), "n": str(getattr(e, "Name", "") or ""), "c": e.is_a(), "tipo": tag})
        ripiego += len(prodotti) - n0
    close_chunk()
    falliti = []
    log = ""
    try:
        log = W.get_log()
    except Exception:  # noqa: BLE001
        pass
    for i in attesi:
        if i not in prodotti:
            e = attesi[i]
            why = ""
            for line in (log or "").splitlines():
                if f"#{i}=" in line or f'"instance": "#{i}' in line or f"#{i} " in line:
                    why = line[:300]
                    break
            falliti.append({"g": getattr(e, "GlobalId", ""), "n": str(getattr(e, "Name", "") or ""), "c": e.is_a(),
                            "motivo": why or t("srv_ifcstep.geometria_non_calcolabile")})
    proj = f.by_type("IfcProject")
    parents = set(parent.values())
    info = {"schema": schema, "nodes": {str(k): v for k, v in nodes.items() if k in prodotti or k in parents or v["c"] == "IfcProject"},
            "attesi": len(attesi), "prodotti": len(prodotti), "falliti": falliti, "ripiego": ripiego, "solo_linee": solo_linee,
            "istanze": inst, "geometrie": geo_names, "approssimati": approssimati,
            "nome": (proj[0].Name if proj and proj[0].Name else Path(src).stem)}
    sp = work_p / "struttura.json"
    sp.write_text(json.dumps(info), encoding="utf-8")
    _out("p", "1")
    _out("done", str(sp))
    return 0


# ================================================================================================= processo di scrittura
class _Writer:
    def __init__(self):
        from OCP.Message import Message
        msgr = Message.DefaultMessenger_s()
        try:
            for p in list(msgr.Printers()):
                msgr.RemovePrinter(p)
        except Exception:  # noqa: BLE001
            pass

    def chunk(self, job: dict) -> dict:
        from OCP.BRep import BRep_Builder
        from OCP.BRepTools import BRepTools
        from OCP.TopoDS import TopoDS_Shape
        B = BRep_Builder()
        skip = set(job.get("skip") or ())
        crash = os.environ.get("MBV_IFCSTEP_CRASH")
        fac = _Faceted()
        occ = None
        res = {"fac": 0, "occ": 0, "mesh": 0, "linee": 0, "falliti": [], "geo_occ": [], "geo_falliti": []}
        fac.open(job["out"] + ".fac.part")
        with open(job["in"], "rb") as fi:
            while True:
                h = fi.read(13)
                if len(h) < 13:
                    break
                ml, kind, dl = struct.unpack("<IBQ", h)
                meta = json.loads(fi.read(ml))
                data = fi.read(dl)
                el = meta["id"]
                key = ("g" if kind == 3 else "e") + str(el)  # 3 = geometria condivisa (el = indice), 0 = elemento
                if key in skip:
                    if kind == 3:
                        res["geo_falliti"].append(el)
                    else:
                        res["falliti"].append({"id": el, "motivo": "crash"})
                    continue
                _out("el", key)
                if crash and meta.get("n") == crash:  # collaudo: crash simulato del processo su questo elemento
                    os.abort()
                try:
                    shape = TopoDS_Shape()
                    BRepTools.Read_s(shape, io.BytesIO(data), B)
                    del data
                    if meta.get("m"):
                        shape = _place(shape, meta["m"])
                    items = _items(shape, meta)
                    if not items:
                        if kind == 3:
                            res["geo_falliti"].append(el)
                        elif meta.get("att"):
                            res["falliti"].append({"id": el, "motivo": t("srv_ifcstep.nessuna_faccia")})
                        else:
                            res["linee"] += 1
                        continue
                    polys = [_polyhedron(s) or _polyhedron(s, open_ok=True) for s, _c in items]
                    if all(p is not None for p in polys):
                        pc = [(p, c) for p, (_s, c) in zip(polys, items)]
                        if kind == 3:
                            fac.geometry(el, pc)
                        else:
                            fac.element(el, pc)
                            res["fac"] += 1
                    else:
                        if occ is None:
                            occ = _Occ()
                        if kind == 3:  # geometria condivisa non a facce piane: parte STEP richiamata dagli elementi
                            occ.element(el, items, "MBDG")
                            res["geo_occ"].append(el)
                        else:
                            occ.element(el, items)
                            res["occ"] += 1
                except Exception as e:  # noqa: BLE001
                    if kind == 3:
                        res["geo_falliti"].append(el)
                    else:
                        res["falliti"].append({"id": el, "motivo": str(e)[:200] or type(e).__name__})
        if fac.n or fac.ng:
            res["fac_path"] = job["out"] + ".fac"
            res["fac_map"] = fac.save(res["fac_path"])
        if occ is not None and occ.n:
            res["occ_path"] = job["out"] + ".stp"
            occ.save(res["occ_path"])
        try:
            os.remove(job["in"])  # il blocco letto non serve piu': spazio temporaneo limitato ai blocchi in lavorazione
        except OSError:
            pass
        return res


def _place(shape, m):
    """Forma in coordinate locali + matrice 4x4 per colonne (metri) -> forma nelle coordinate del progetto."""
    from OCP.gp import gp_GTrsf, gp_Mat, gp_Trsf, gp_XYZ
    from OCP.TopLoc import TopLoc_Location
    if _rigid(m):
        tr = gp_Trsf()
        tr.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14])
        return shape.Moved(TopLoc_Location(tr))
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    g = gp_GTrsf()
    g.SetVectorialPart(gp_Mat(m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]))
    g.SetTranslationPart(gp_XYZ(m[12], m[13], m[14]))
    return BRepBuilderAPI_GTransform(shape, g, True).Shape()


def _items(shape, meta: dict) -> list:
    """Parti dell'elemento con il loro colore: solidi (le superfici chiuse si cuciono in solidi); le linee si scartano."""
    from OCP.TopAbs import TopAbs_COMPOUND, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS_Iterator
    cols = meta.get("cols") or []
    ids = meta.get("ids") or []
    kids = []
    if shape.ShapeType() == TopAbs_COMPOUND:
        it = TopoDS_Iterator(shape)
        while it.More():
            kids.append(it.Value())
            it.Next()
    else:
        kids = [shape]
    if len(ids) != len(kids):
        ids = [ids[0] if ids else -1] * len(kids)
    out = []
    loose = []  # facce sciolte (mesh): si provano a cucire in solidi
    loose_col = None
    for k, i in zip(kids, ids):
        c = cols[i] if 0 <= i < len(cols) else None
        tp = k.ShapeType()
        if tp == TopAbs_SOLID:
            out.append((k, c))
        elif tp == TopAbs_COMPOUND:
            e = TopExp_Explorer(k, TopAbs_SOLID)
            got = False
            while e.More():
                out.append((e.Current(), c))
                got = True
                e.Next()
            if not got and TopExp_Explorer(k, TopAbs_FACE).More():
                loose.append(k)
                loose_col = loose_col or c
        elif tp in (TopAbs_SHELL, TopAbs_FACE):
            loose.append(k)
            loose_col = loose_col or c
    if loose:
        nf = 0
        for s in loose:
            e = TopExp_Explorer(s, TopAbs_FACE)
            while e.More() and nf <= SEW_MAX:
                nf += 1
                e.Next()
        if nf > SEW_MAX:
            # reti enormi di facce sciolte (es. grigliati "orsogrill" da 36.000 facce): la cucitura manda in crash
            # OpenCascade; si scrivono come superficie, la geometria e' la stessa
            from OCP.BRep import BRep_Builder
            from OCP.TopoDS import TopoDS_Compound
            comp, b = TopoDS_Compound(), BRep_Builder()
            b.MakeCompound(comp)
            for s in loose:
                b.Add(comp, s)
            out.append((comp, loose_col))
        else:
            for s in _sew(loose):
                out.append((s, loose_col))
    return out


def _sew(shapes: list) -> list:
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.TopAbs import TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.ShapeFix import ShapeFix_Solid
    sew = BRepBuilderAPI_Sewing(1e-6)
    for s in shapes:
        sew.Add(s)
    sew.Perform()
    res = sew.SewedShape()
    out = []
    e = TopExp_Explorer(res, TopAbs_SHELL)
    while e.More():
        sh = TopoDS.Shell(e.Current())
        if sh.Closed() or BRepCheck_Analyzer(sh).IsValid() and _closed(sh):
            try:
                ms = BRepBuilderAPI_MakeSolid(sh)
                fx = ShapeFix_Solid(ms.Solid())
                fx.Perform()
                out.append(fx.Solid())
            except Exception:  # noqa: BLE001
                out.append(sh)
        else:
            out.append(sh)
        e.Next()
    if not out:
        out = list(shapes)
    return out


def _closed(shell) -> bool:
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    try:
        from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
    except ImportError:  # nome della mappa nelle versioni recenti di OCP
        from OCP.OCP.collections import IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as TopTools_IndexedDataMapOfShapeListOfShape
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shell, TopAbs_EDGE, TopAbs_FACE, m)
    for i in range(1, m.Extent() + 1):
        e = m.FindKey(i)
        if m.FindFromIndex(i).Size() != 2 and not BRep_Tool.Degenerated_s(TopoDS.Edge(e)):
            return False
    return True


def _polyhedron(shape, open_ok=False):
    """Solido chiuso a facce piane e lati dritti -> {pts, faces: [[anello esterno, fori...]]} in metri; altrimenti None.
    open_ok: anche facce sciolte (superficie aperta, "open": True)."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepTools import BRepTools, BRepTools_WireExplorer
    from OCP.GeomAbs import GeomAbs_Line, GeomAbs_Plane
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_WIRE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    if shape.ShapeType() != TopAbs_SOLID and not open_ok:
        return None
    pts: dict[tuple, int] = {}
    P: list[tuple] = []
    faces = []
    fe = TopExp_Explorer(shape, TopAbs_FACE)
    while fe.More():
        face = TopoDS.Face(fe.Current())
        if BRepAdaptor_Surface(face, False).GetType() != GeomAbs_Plane:
            return None
        outer = BRepTools.OuterWire_s(face)
        loops = []
        we = TopExp_Explorer(face, TopAbs_WIRE)
        while we.More():
            wire = TopoDS.Wire(we.Current())
            lp = []
            wx = BRepTools_WireExplorer(wire, face)
            while wx.More():
                if BRepAdaptor_Curve(wx.Current()).GetType() != GeomAbs_Line:
                    return None
                p = BRep_Tool.Pnt_s(wx.CurrentVertex())
                key = (p.X(), p.Y(), p.Z())  # vertici condivisi = coordinate identiche
                j = pts.get(key)
                if j is None:
                    j = pts[key] = len(P)
                    P.append(key)
                if not lp or lp[-1] != j:
                    lp.append(j)
                wx.Next()
            if len(lp) > 1 and lp[0] == lp[-1]:
                lp.pop()
            if len(lp) >= 3:
                if wire.IsSame(outer):
                    loops.insert(0, lp)
                else:
                    loops.append(lp)
            we.Next()
        if loops:
            if face.Orientation() == TopAbs_REVERSED:
                pass  # TopExp_Explorer compone gia' l'orientamento: gli anelli seguono la faccia orientata
            faces.append(loops)
        fe.Next()
    if open_ok and shape.ShapeType() != TopAbs_SOLID:
        return {"P": P, "F": faces, "open": True} if faces else None
    if len(faces) < 4:
        return None
    return {"P": P, "F": faces}


class _Faceted:
    """Scrittore dei solidi a facce piane (FACETED_BREP, mm). Numeri locali #n, entita' globali @n (vedi GLOBAL)."""

    def __init__(self):
        self.lines: list[str] = []
        self.nid = 0
        self.n = 0
        self.map: dict[int, tuple[int, int]] = {}
        self.gmap: dict[int, tuple[int, int]] = {}  # geometria condivisa -> (rappresentazione, asse)
        self.ng = 0
        self.styled: list[int] = []
        self.colours: dict[tuple, int] = {}

    def A(self, s: str) -> int:
        self.nid += 1
        self.lines.append(f"#{self.nid}={s};\n")
        return self.nid

    def style(self, c) -> int:
        key = tuple(c) if c else tuple(GRIGIO)
        sid = self.colours.get(key)
        if sid is None:
            r, g, b, a = (list(key) + [1.0])[:4]
            A = self.A
            col = A(f"COLOUR_RGB('',{_num(r)},{_num(g)},{_num(b)})")
            fas = A(f"FILL_AREA_STYLE('',(#{A(f'FILL_AREA_STYLE_COLOUR({chr(39)}{chr(39)},#{col})')}))")
            elems = [f"#{A(f'SURFACE_STYLE_FILL_AREA(#{fas})')}"]
            if a < 0.999:
                elems.append(f"#{A(f'SURFACE_STYLE_TRANSPARENT({_num(1 - a)})')}")
            sss = A(f"SURFACE_SIDE_STYLE('',({','.join(elems)}))")
            sid = A(f"PRESENTATION_STYLE_ASSIGNMENT((#{A(f'SURFACE_STYLE_USAGE(.BOTH.,#{sss})')}))")
            self.colours[key] = sid
        return sid

    def geometry(self, gi: int, polys: list):
        """Geometria condivisa (coordinate locali, metri): solo la rappresentazione, gli elementi la richiamano (MAPPED_ITEM)."""
        breps = self._breps(polys)
        ax = self.A("AXIS2_PLACEMENT_3D('',@10,@11,@12)")
        sr = self.A(f"{self._rep()}('',({','.join('#%d' % b for b in breps)},#{ax}),@9)")
        self.gmap[gi] = (sr, ax)
        self.ng += 1
        if len(self.lines) > 20000:
            self._flush()

    def element(self, el: int, polys: list):
        A = self.A
        breps = self._breps(polys)
        ax = A("AXIS2_PLACEMENT_3D('',@10,@11,@12)")
        sr = A(f"{self._rep()}('',({','.join('#%d' % b for b in breps)},#{ax}),@9)")
        prod = A(f"PRODUCT('MBDE{el}','MBDE{el}','',(@3))")
        A(f"PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#{prod}))")
        pdf = A(f"PRODUCT_DEFINITION_FORMATION('','',#{prod})")
        pd = A(f"PRODUCT_DEFINITION('design','',#{pdf},@4)")
        pds = A(f"PRODUCT_DEFINITION_SHAPE('','',#{pd})")
        A(f"SHAPE_DEFINITION_REPRESENTATION(#{pds},#{sr})")
        self.map[el] = (pd, sr)
        self.n += 1
        if len(self.lines) > 20000:
            self._flush()

    def _rep(self) -> str:
        r = "SHAPE_REPRESENTATION" if self.open_rep else "FACETED_BREP_SHAPE_REPRESENTATION"
        self.open_rep = False
        return r

    def _breps(self, polys: list) -> list:
        self.open_rep = False
        A = self.A
        breps = []
        for poly, c in polys:
            P = poly["P"]
            ids: dict[int, int] = {}

            def pt(i):
                v = ids.get(i)
                if v is None:
                    x, y, z = P[i]
                    v = ids[i] = A(f"CARTESIAN_POINT('',({_num(x * 1000)},{_num(y * 1000)},{_num(z * 1000)}))")
                return v

            fids = []
            for loops in poly["F"]:
                o = loops[0]
                # normale di Newell dell'anello esterno (verso = orientamento della faccia)
                nx = ny = nz = 0.0
                for a, b in zip(o, o[1:] + o[:1]):
                    (x1, y1, z1), (x2, y2, z2) = P[a], P[b]
                    nx += (y1 - y2) * (z1 + z2)
                    ny += (z1 - z2) * (x1 + x2)
                    nz += (x1 - x2) * (y1 + y2)
                nl = math.sqrt(nx * nx + ny * ny + nz * nz)
                if nl < 1e-18:
                    continue
                nx, ny, nz = nx / nl, ny / nl, nz / nl
                (x0, y0, z0), (x1, y1, z1) = P[o[0]], P[o[1]]
                ux, uy, uz = x1 - x0, y1 - y0, z1 - z0
                d = ux * nx + uy * ny + uz * nz  # direzione x perpendicolare alla normale
                ux, uy, uz = ux - d * nx, uy - d * ny, uz - d * nz
                ul = math.sqrt(ux * ux + uy * uy + uz * uz)
                if ul < 1e-15:
                    continue
                dz = A(f"DIRECTION('',({_num(nx, 12)},{_num(ny, 12)},{_num(nz, 12)}))")
                dx = A(f"DIRECTION('',({_num(ux / ul, 12)},{_num(uy / ul, 12)},{_num(uz / ul, 12)}))")
                pl = A(f"PLANE('',#{A(f'AXIS2_PLACEMENT_3D({chr(39)}{chr(39)},#{pt(o[0])},#{dz},#{dx})')})")
                bounds = []
                for li, lp in enumerate(loops):
                    pl_ = A(f"POLY_LOOP('',({','.join('#%d' % pt(v) for v in lp)}))")
                    bounds.append(A(f"{'FACE_BOUND' if li else 'FACE_OUTER_BOUND'}('',#{pl_},.T.)"))
                fids.append(A(f"FACE_SURFACE('',({','.join('#%d' % b for b in bounds)}),#{pl},.T.)"))
            if not fids:
                continue
            if poly.get("open"):  # superficie aperta (facce sciolte)
                br = A(f"SHELL_BASED_SURFACE_MODEL('',(#{A(f'OPEN_SHELL({chr(39)}{chr(39)},({chr(44).join(chr(35) + str(f) for f in fids)}))')}))")
                self.open_rep = True
            else:
                shell = A(f"CLOSED_SHELL('',({','.join('#%d' % f for f in fids)}))")
                br = A(f"FACETED_BREP('',#{shell})")
            breps.append(br)
            self.styled.append(A(f"STYLED_ITEM('color',(#{self.style(c)}),#{br})"))
        if not breps:
            raise ValueError(t("srv_ifcstep.nessuna_faccia"))
        return breps

    def _flush(self):
        if not hasattr(self, "_f"):
            self._f = open(self._path_tmp, "w", encoding="ascii", newline="\n")
        self._f.write("".join(self.lines))
        self.lines = []

    def open(self, path: str):
        self._path_tmp = path

    def save(self, path: str) -> dict:
        if self.styled:
            for i in range(0, len(self.styled), 50000):
                part = self.styled[i:i + 50000]
                self.A(f"MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',({','.join('#%d' % s for s in part)}),@9)")
        self._path_tmp = getattr(self, "_path_tmp", path)
        self._flush()
        self._f.close()
        if self._path_tmp != path:
            os.replace(self._path_tmp, path)
        return {"els": {str(k): v for k, v in self.map.items()}, "geo": {str(k): v for k, v in self.gmap.items()}}


class _Occ:
    """Elementi con superfici curve: documento XCAF di OpenCascade (nome provvisorio MBDE<id>, colori per parte)."""

    def __init__(self):
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDocStd import TDocStd_Document
        from OCP.XCAFApp import XCAFApp_Application
        from OCP.XCAFDoc import XCAFDoc_DocumentTool
        self.doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
        XCAFApp_Application.GetApplication_s().InitDocument(self.doc)
        XCAFDoc_DocumentTool.SetLengthUnit_s(self.doc, 1.0)  # forme in metri
        self.st = XCAFDoc_DocumentTool.ShapeTool_s(self.doc.Main())
        self.ct = XCAFDoc_DocumentTool.ColorTool_s(self.doc.Main())
        self.n = 0

    def element(self, el: int, items: list, token: str = "MBDE"):
        from OCP.BRep import BRep_Builder
        from OCP.Quantity import Quantity_Color, Quantity_ColorRGBA, Quantity_TOC_RGB
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TopoDS import TopoDS_Compound
        from OCP.XCAFDoc import XCAFDoc_ColorSurf
        # una forma con posizione propria diventerebbe un sotto-assieme ("SOLID"): si mette in un compound senza posizione
        if len(items) == 1 and items[0][0].Location().IsIdentity():
            shape = items[0][0]
        else:
            shape = TopoDS_Compound()
            b = BRep_Builder()
            b.MakeCompound(shape)
            for s, _c in items:
                b.Add(shape, s)
        lab = self.st.AddShape(shape, False, False)
        TDataStd_Name.Set_s(lab, TCollection_ExtendedString(f"{token}{el}"))

        def qc(c):
            return Quantity_ColorRGBA(Quantity_Color(c[0], c[1], c[2], Quantity_TOC_RGB), c[3] if len(c) > 3 else 1.0)

        cs = [c or GRIGIO for _s, c in items]  # senza stile: lo stesso grigio dei solidi a facce piane
        if len({tuple(c) if c else None for c in cs}) <= 1:
            if cs and cs[0]:
                self.ct.SetColor(lab, qc(cs[0]), XCAFDoc_ColorSurf)
        else:
            for (s, _c), c in zip(items, cs):
                if c:
                    sub = self.st.AddSubShape(lab, s)
                    if not sub.IsNull():
                        self.ct.SetColor(sub, qc(c), XCAFDoc_ColorSurf)
        self.n += 1

    def save(self, path: str):
        from OCP.Interface import Interface_Static
        from OCP.STEPCAFControl import STEPCAFControl_Writer
        from OCP.STEPControl import STEPControl_AsIs
        w = STEPCAFControl_Writer()
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        Interface_Static.SetIVal_s("write.surfacecurve.mode", 0)  # niente curve nello spazio parametrico: file ~40% piu' piccolo
        Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
        w.SetColorMode(True)
        w.SetNameMode(True)
        w.SetLayerMode(False)
        if not w.Transfer(self.doc, STEPControl_AsIs):
            raise RuntimeError("STEPCAFControl Transfer")
        if int(w.Write(path)) != 1:  # IFSelect_RetDone
            raise RuntimeError("STEPCAFControl Write")


def write_main() -> int:
    w = _Writer()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        job = json.loads(line)
        res = w.chunk(job)
        _out("ok", json.dumps(res))
    return 0


def cli(argv: list[str]) -> int:
    from . import longpath
    longpath.install()  # percorsi lunghi anche nel processo di lavoro
    args = [a for a in argv[1:] if a != "--ifcstep"]
    if not args:
        return 2
    try:
        if args[0] == "read":
            code = read_main(args[1], args[2])
        elif args[0] == "write":
            code = write_main()
        else:
            code = 2
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        _out("err", str(e)[:500])
        code = 3
    sys.stdout.flush()
    os._exit(code)  # niente distruttori di OpenCascade all'uscita (a volte vanno in crash)


if __name__ == "__main__":
    cli(sys.argv)
