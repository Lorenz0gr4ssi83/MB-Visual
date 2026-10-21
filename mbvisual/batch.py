"""Conversione a lotti: molti file (una cartella con o senza sottocartelle, o file scelti) in un formato, in background.

Un lotto e' una coda sequenziale con avanzamento, annullabile, e un rapporto finale (riusciti, saltati, falliti con il motivo).
Le uscite vanno accanto agli originali o in una cartella scelta replicando la struttura delle sottocartelle.

Motori: si riusa il convertitore di "Salva con nome" (convert.py: Office via COM, PyMuPDF, Pillow, FFmpeg...) e gli strumenti
PDF (pdfedit.py, pdftools.py). Due famiglie si leggono solo nel browser e passano dalla pagina dell'app (ui/js/batch.js):
- DWG senza ODA File Converter: libredwg (WASM) decodifica il disegno nella pagina e manda qui il database; qui ezdxf
  ricostruisce modello e fogli (con le finestre) e li disegna in PDF/SVG/PNG/DXF (DXF: direttamente con ezdxf).
- Modelli 3D e BIM (IFC, STEP, IGES, mesh): la pagina monta il visualizzatore 3D in un contenitore nascosto e usa
  il suo salvataggio (export3d.js / esportatori di three.js), lo stesso di "Salva con nome".
Il lavoro "lato pagina" e' un compito che questo modulo pubblica nello stato del lotto e attende (la pagina lo prende,
lo esegue e risponde con api/batch?op=client); se la pagina non risponde il file fallisce con un motivo chiaro.
"""
import csv
import os
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path

from . import convert
from .paths import TEMP_DIR

NO_WINDOW = 0x08000000
CAD = {"dwg", "dxf"}
MODEL3D = set("ifc step stp p21 stpz iges igs brep brp stl obj ply gltf glb fbx 3ds dae 3mf amf wrl vrml 3dm usdz".split())
MODEL3D_OUT = [("glb", "glTF binario"), ("step", "STEP (facce piane)"), ("ifc", "IFC 4"), ("stl", "STL"), ("obj", "OBJ"), ("3mf", "3MF"),
               ("gltf", "glTF testo"), ("ply", "PLY"), ("dxf", "DXF 3D"), ("wrl", "VRML"), ("usdz", "USDZ")]
CAD_OUT = [("pdf", "PDF (modello e fogli)"), ("svg", "SVG"), ("png", "PNG"), ("dxf", "DXF")]
PDF_FAMS = {"word", "sheet", "slides", "email", "image", "svg", "html", "markdown", "text", "xps", "epub", "cad"}
SKIP = ("~$", ".")
SKIP_NAMES = {"desktop.ini", "thumbs.db"}
MAX_FILES = 20000
PAPER = {"A4": (297, 210), "A3": (420, 297), "A2": (594, 420), "A1": (841, 594), "A0": (1189, 841)}

OPS = {
    "pdf": "Converti in PDF",
    "format": "Converti in un altro formato",
    "image": "Immagini: ridimensiona, converti, comprimi",
    "pdf_merge": "Unisci in un unico PDF",
    "pdf_compress": "PDF: comprimi",
    "pdf_ocr": "PDF scansionati: rendi ricercabili (OCR)",
    "video": "Video: MP4 compresso",
}


class Cancelled(Exception):
    pass


def family(path: str) -> str | None:
    ext = Path(path).suffix.lower().lstrip(".")
    if ext in CAD:
        return "cad"
    if ext in MODEL3D:
        return "model3d"
    return convert.FAMILY_OF.get(ext)


def _targets(fam: str | None) -> list[tuple[str, str]]:
    if fam == "cad":
        return CAD_OUT
    if fam == "model3d":
        return MODEL3D_OUT
    return convert.TARGETS.get(fam, [])


def applies(op: str, fam: str | None, ext: str, opts: dict) -> bool:
    if op == "pdf":
        return fam in PDF_FAMS
    if op == "format":
        to = opts.get("to")
        same = {"jpeg": "jpg", "tif": "tiff", "htm": "html", "stp": "step"}
        if same.get(ext, ext) == same.get(to, to) and fam != "pdf":
            return False
        return any(e == to for e, _ in _targets(fam))
    if op == "image":
        return fam == "image"
    if op == "pdf_merge":
        return fam == "pdf" or (bool(opts.get("convert_others", True)) and fam in PDF_FAMS)
    if op in ("pdf_compress", "pdf_ocr"):
        return fam == "pdf"
    if op == "video":
        return fam == "media"
    return False


# ---------------------------------------------------------------- scansione
def scan(paths: list[str], recursive: bool = True) -> dict:
    """File da convertire. rel = percorso relativo alla cartella scelta (serve a replicare la struttura in uscita)."""
    files, roots = [], [p for p in paths if os.path.isdir(p)]
    multi = len(roots) > 1

    def add(p, rel):
        name = os.path.basename(p)
        if name.startswith(SKIP) or name.lower() in SKIP_NAMES:
            return
        try:
            size = os.path.getsize(p)
        except OSError:
            return
        ext = Path(p).suffix.lower().lstrip(".")
        files.append({"path": p, "rel": rel, "size": size, "ext": ext, "fam": family(p)})

    for p in paths:
        p = os.path.abspath(p)
        if os.path.isdir(p):
            base = Path(p)
            prefix = Path(base.name) if multi else Path()
            it = base.rglob("*") if recursive else base.glob("*")
            for f in it:
                if len(files) >= MAX_FILES:
                    break
                if any(part.startswith(SKIP) for part in f.relative_to(base).parts[:-1]):
                    continue
                if f.is_file():
                    add(str(f), str(prefix / f.relative_to(base)))
        elif os.path.isfile(p):
            add(p, os.path.basename(p))
    files.sort(key=lambda f: f["rel"].lower())
    counts = {}
    for f in files:
        counts[f["fam"] or "altro"] = counts.get(f["fam"] or "altro", 0) + 1
    # formati di destinazione possibili con il numero di file a cui si applicano
    tg = {}
    for f in files:
        for e, label in _targets(f["fam"]):
            if e == f["ext"] and f["fam"] not in ("pdf",):
                continue
            t = tg.setdefault(e, {"ext": e, "label": label, "n": 0})
            t["n"] += 1
    return {"ok": True, "files": files, "counts": counts, "targets": sorted(tg.values(), key=lambda t: (-t["n"], t["ext"])),
            "fam_targets": {fam: [e for e, _ in _targets(fam)] for fam in {f["fam"] for f in files} if fam},
            "root": roots[0] if len(roots) == 1 else "", "troppi": len(files) >= MAX_FILES, "ops": OPS}


# ---------------------------------------------------------------- lotto
_BATCHES: dict[str, "Batch"] = {}
_LOCK = threading.Lock()
_RUN_LOCK = threading.Lock()  # un lotto alla volta (Office via COM e FFmpeg non amano lavorare in parallelo)


class Batch:
    def __init__(self, spec: dict):
        self.id = uuid.uuid4().hex[:10]
        self.op = spec.get("op") or "pdf"
        if self.op not in OPS:
            raise ValueError("Operazione sconosciuta")
        self.opts = spec.get("opts") or {}
        out = spec.get("out") or {}
        self.mode = out.get("mode") or "accanto"
        self.dest = os.path.abspath(out["dir"]) if out.get("dir") else ""
        if self.mode == "cartella" and not self.dest:
            raise ValueError("Scegli la cartella di uscita")
        self.collision = out.get("collision") or "rinomina"
        self.suffix = out.get("suffix") or ""
        self.items = []
        for f in spec.get("files") or []:
            p = os.path.abspath(f["path"])
            fam = family(p)
            ext = Path(p).suffix.lower().lstrip(".")
            it = {"src": p, "rel": f.get("rel") or os.path.basename(p), "fam": fam, "status": "attesa", "msg": "", "out": [], "t": 0.0}
            if not applies(self.op, fam, ext, self.opts):
                it["status"] = "saltato"
                it["msg"] = ("E' gia' un PDF" if fam == "pdf" and self.op == "pdf" else "Formato non convertibile" if not fam
                             else "Formato di destinazione non disponibile per questo tipo di file" if self.op == "format"
                             else "Non interessato da questa operazione")
            self.items.append(it)
        self.status = "attesa"
        self.cancelled = False
        self.current = -1
        self.cur_progress = 0.0
        self.message = ""
        self.started = time.time()
        self.ended = None
        self.report = ""
        self.merged = None
        self.proc = None
        self.task = None
        self.task_seq = 0
        self.task_result = None
        self.task_event = threading.Event()
        self.last_poll = time.time()
        self.used_outputs = set()
        self.office = {}
        self.new_outputs = []

    # ------------------------------------------------------------ stato per l'interfaccia
    def state(self, full=True) -> dict:
        n = len(self.items)
        todo = [i for i in self.items if i["status"] != "saltato"]
        done = sum(1 for i in todo if i["status"] in ("ok", "errore", "annullato"))
        prog = 1.0 if self.status in ("finito", "annullato") else (done + self.cur_progress) / max(len(todo), 1)
        s = {"ok": True, "id": self.id, "op": self.op, "label": OPS[self.op], "status": self.status, "progress": prog, "message": self.message,
             "current": self.current, "totale": n, "da_fare": len(todo), "fatti": done,
             "riusciti": sum(1 for i in self.items if i["status"] == "ok"), "falliti": sum(1 for i in self.items if i["status"] == "errore"),
             "saltati": sum(1 for i in self.items if i["status"] == "saltato"), "started": self.started, "ended": self.ended,
             "report": self.report, "unito": self.merged, "uscita": self.dest if self.mode == "cartella" else "",
             "task": self._public_task()}
        if full:
            s["items"] = self.items
        return s

    def _public_task(self):
        t = self.task
        return None if t is None else {k: v for k, v in t.items() if k != "taken"} | {"preso": bool(t.get("taken"))}

    # ------------------------------------------------------------ esecuzione
    def run(self):
        with _RUN_LOCK:
            self.status = "in corso"
            final = "errore"
            try:
                tmp = Path(tempfile.mkdtemp(prefix="lotto-", dir=TEMP_DIR))
                self.tmp = tmp
                merge_parts = []
                for idx, it in enumerate(self.items):
                    if it["status"] == "saltato":
                        continue
                    if self.cancelled:
                        it["status"] = "annullato"
                        continue
                    self.current, self.cur_progress = idx, 0.0
                    self.message = it["rel"]
                    it["status"] = "in corso"
                    t0 = time.time()
                    self.new_outputs = []
                    try:
                        res = self._do(it, merge_parts)
                        it["status"] = "ok"
                        if isinstance(res, dict) and res.get("msg"):
                            it["msg"] = res["msg"]
                    except _Skip as s:
                        it["status"] = "saltato"
                        it["msg"] = str(s)
                    except Cancelled:
                        it["status"] = "annullato"
                        it["msg"] = "Interrotto"
                    except Exception as e:  # noqa: BLE001
                        it["status"] = "errore"
                        it["msg"] = _reason(e)
                        it["trace"] = traceback.format_exc()[-2000:]
                    if it["status"] in ("annullato", "errore"):
                        # niente file a meta': si tolgono le uscite create da questo file (non quelle che esistevano gia')
                        for p in self.new_outputs:
                            try:
                                os.remove(p)
                            except OSError:
                                pass
                        it["out"] = []
                    it["t"] = round(time.time() - t0, 1)
                    self.cur_progress = 0.0
                if self.op == "pdf_merge" and merge_parts and not self.cancelled:
                    self.message = "Unione dei PDF"
                    self.merged = self._merge(merge_parts)
                final = "annullato" if self.cancelled else "finito"
            except Exception as e:  # noqa: BLE001
                final = "errore"
                self.message = _reason(e)
            finally:
                self.current = -1
                self.task = None
                self._office_close()
                self.ended = time.time()
                try:
                    self.report = self._write_report()
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
                shutil.rmtree(getattr(self, "tmp", ""), ignore_errors=True)
                # lo stato finale per ultimo: chi lo legge trova gia' il rapporto
                self.status = final

    def update(self, progress=None, message=None):
        if self.cancelled:
            raise Cancelled()
        if progress is not None:
            self.cur_progress = max(0.0, min(0.99, float(progress)))

    def cancel(self):
        self.cancelled = True
        if self.task is not None:
            self.task_event.set()
        p = self.proc
        if p and p.poll() is None:
            try:
                p.kill()
            except OSError:
                pass

    # ------------------------------------------------------------ uscite
    def out_path(self, it, ext: str, tag: str = "") -> str:
        src = Path(it["src"])
        folder = src.parent if self.mode == "accanto" else Path(self.dest) / Path(it["rel"]).parent
        folder.mkdir(parents=True, exist_ok=True)
        stem = src.stem + self.suffix
        out = folder / f"{stem}.{ext}"
        if out.resolve() == src.resolve():  # mai sopra l'originale
            out = folder / f"{stem}{tag or ' (convertito)'}.{ext}"
        if str(out).lower() in self.used_outputs or (out.exists() and self.collision == "rinomina"):
            n = 1
            while True:
                cand = folder / f"{out.stem} ({n}){out.suffix}"
                if not cand.exists() and str(cand).lower() not in self.used_outputs:
                    out = cand
                    break
                n += 1
        elif out.exists() and self.collision == "salta":
            raise _Skip(f"Esiste gia': {out.name}")
        self.used_outputs.add(str(out).lower())
        if not out.exists():
            self.new_outputs.append(str(out))
        return str(out)

    def _do(self, it, merge_parts):
        op, fam, src = self.op, it["fam"], it["src"]
        if op == "pdf":
            return self._to(it, "pdf")
        if op == "format":
            return self._to(it, self.opts["to"])
        if op == "image":
            return self._image(it)
        if op == "pdf_merge":
            if fam == "pdf":
                import pymupdf
                with pymupdf.open(src) as d:  # PDF danneggiati o protetti: falliscono qui, con il motivo
                    if d.needs_pass:
                        raise RuntimeError("Il PDF e' protetto da password")
                    n = len(d)
                merge_parts.append((src, it["rel"]))
                return {"msg": f"Aggiunto all'unione ({n} pagine)"}
            else:
                tmp_out = str(self.tmp / f"{len(merge_parts):05d}.pdf")
                self._convert_to(it, "pdf", tmp_out)
                merge_parts.append((tmp_out, it["rel"]))
            return {"msg": "Aggiunto all'unione"}
        if op == "pdf_compress":
            from . import pdfedit
            out = self.out_path(it, "pdf", " (compresso)")
            r = pdfedit.compress(src, out, int(self.opts.get("dpi", 150)), int(self.opts.get("quality", 75)))
            it["out"] = [out]
            gain = 1 - r["dopo"] / max(r["prima"], 1)
            return {"msg": f"{_size(r['prima'])} -> {_size(r['dopo'])}" + (f" (-{gain:.0%})" if gain > 0 else " (nessun guadagno)")}
        if op == "pdf_ocr":
            from . import pdfedit
            out = self.out_path(it, "pdf", " (OCR)")
            r = pdfedit.ocr(src, out, int(self.opts.get("dpi", 300)), update=self.update)
            it["out"] = [out]
            return {"msg": f"{r['pagine']} pagine riconosciute, {r['parole']} parole" if r["pagine"] else "Il PDF aveva gia' il testo"}
        if op == "video":
            return self._video(it)
        raise ValueError("Operazione sconosciuta")

    # ------------------------------------------------------------ conversione di formato
    def _to(self, it, to):
        fam = it["fam"]
        if fam == "pdf" and to == "pdf" and self.op == "pdf":
            raise _Skip("E' gia' un PDF")
        out = self.out_path(it, to)
        res = self._convert_to(it, to, out) or {}
        outs = res.get("files") or ([res["cartella"]] if res.get("cartella") else [out])
        it["out"] = [o for o in outs if o and os.path.exists(o)] or [out]
        return {"msg": res.get("msg", "")}

    def _convert_to(self, it, to, out):
        fam, src = it["fam"], it["src"]
        if fam == "cad":
            return self._cad(it, to, out)
        if fam == "model3d":
            self._client(it, "model3d", {"out": out, "to": to})
            if not os.path.exists(out):
                raise RuntimeError("Il modello non e' stato salvato")
            return {}
        if fam in ("word", "sheet", "slides") or (fam == "html" and to not in ("pdf", "txt", "html", "htm", "mht")):
            r = self._office_convert("word" if fam == "html" else fam, src, to, out)
            if r is not None:
                return r
        try:
            return convert.convert(src, out, update=self.update)
        except Exception as e:  # noqa: BLE001
            # Office appena chiuso dal file precedente: un secondo tentativo dopo una breve pausa di solito riesce
            if "com_error" not in repr(e) and "-2147" not in str(e):
                raise
            time.sleep(3)
            return convert.convert(src, out, update=self.update)

    # ------------------------------------------------------------ Office: un'istanza per programma per tutto il lotto
    def _office_app(self, progid):
        app = self.office.get(progid)
        if app is not None:
            try:
                _ = app.Name  # ancora vivo?
                return app
            except Exception:  # noqa: BLE001
                self.office.pop(progid, None)
        app = convert._com(progid)
        self.office[progid] = app
        return app

    def _office_drop(self, progid):
        app = self.office.pop(progid, None)
        if app is not None:
            try:
                app.Quit()
            except Exception:  # noqa: BLE001
                pass

    def _office_close(self):
        for progid in list(self.office):
            self._office_drop(progid)

    def _office_convert(self, fam, src, to, out):
        """Come convert._office_* ma senza riavviare il programma a ogni file (avvio di Word/Excel/PowerPoint: 30-100 s).
        None = formato non gestito qui (se ne occupa convert.convert). Una password finta evita le finestre di richiesta
        sui file protetti: falliscono subito invece di bloccare la coda."""
        from .paths import find_office
        src, out = os.path.abspath(src), os.path.abspath(out)
        if fam == "word" and to in convert.WORD_FMT and find_office("winword.exe"):
            progid = "Word.Application"
            try:
                word = self._office_app(progid)
                doc = word.Documents.Open(src, ConfirmConversions=False, ReadOnly=True, AddToRecentFiles=False, Visible=False,
                                          PasswordDocument="mbv-nessuna-password", NoEncodingDialog=True)
                try:
                    self.update(progress=0.5)
                    doc.SaveAs2(out, FileFormat=convert.WORD_FMT[to])
                finally:
                    doc.Close(False)
                return {}
            except Cancelled:
                raise
            except Exception:
                self._office_drop(progid)
                raise
        if fam == "sheet" and (to in ("pdf", "xps") or to in convert.EXCEL_FMT) and find_office("excel.exe"):
            progid = "Excel.Application"
            try:
                xl = self._office_app(progid)
                wb = xl.Workbooks.Open(src, UpdateLinks=0, ReadOnly=True, Password="mbv-nessuna-password", AddToMru=False)
                try:
                    self.update(progress=0.5)
                    if to in ("pdf", "xps"):
                        wb.ExportAsFixedFormat(0 if to == "pdf" else 1, out)
                    else:
                        wb.SaveAs(out, FileFormat=convert.EXCEL_FMT[to])
                finally:
                    wb.Close(False)
                return {}
            except Cancelled:
                raise
            except Exception:
                self._office_drop(progid)
                raise
        if fam == "slides" and to in convert.PPT_FMT and to not in ("png", "jpg", "mp4") and find_office("powerpnt.exe"):
            progid = "PowerPoint.Application"
            try:
                pp = self._office_app(progid)
                pres = pp.Presentations.Open(src, ReadOnly=True, Untitled=False, WithWindow=False)
                try:
                    self.update(progress=0.5)
                    pres.SaveAs(out, convert.PPT_FMT[to])
                finally:
                    pres.Close()
                return {}
            except Cancelled:
                raise
            except Exception:
                self._office_drop(progid)
                raise
        return None

    # ------------------------------------------------------------ immagini
    def _image(self, it):
        from . import misc
        Image = misc._pil()
        from PIL import ImageOps
        o = self.opts
        src = it["src"]
        ext = Path(src).suffix.lower().lstrip(".")
        to = (o.get("to") or "uguale").lower()
        if to == "uguale":
            to = ext if ext in misc.PIL_FORMATS and ext not in misc.RAW_EXTS else "jpg"
        to = {"jpeg": "jpg", "tif": "tiff"}.get(to, to)
        if ext in misc.RAW_EXTS:
            im = Image.open(misc.image_to_png(src)["path"])
        else:
            im = Image.open(src)
        exif = im.info.get("exif") if o.get("keep_meta") else None
        icc = im.info.get("icc_profile")
        im = ImageOps.exif_transpose(im)
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        w0, h0 = im.size
        mw, mh, pct = int(o.get("max_w") or 0), int(o.get("max_h") or 0), float(o.get("percent") or 0)
        if pct and 0 < pct != 100:
            im = im.resize((max(1, round(w0 * pct / 100)), max(1, round(h0 * pct / 100))), Image.LANCZOS)
        elif mw or mh:
            k = min(mw / w0 if mw else 1e9, mh / h0 if mh else 1e9)
            if k < 1 or o.get("enlarge"):
                im = im.resize((max(1, round(w0 * k)), max(1, round(h0 * k))), Image.LANCZOS)
        fmt = misc.PIL_FORMATS.get(to)
        if not fmt:
            raise ValueError(f"Formato immagine .{to} non scrivibile")
        if fmt in ("JPEG", "BMP", "PCX", "PPM") and im.mode not in ("RGB", "L"):
            if "A" in im.mode or im.mode == "P":
                rgba = im.convert("RGBA")
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.getchannel("A"))
                im = bg
            else:
                im = im.convert("RGB")
        elif im.mode not in ("RGB", "RGBA", "L", "LA", "P", "1", "I;16"):
            im = im.convert("RGBA")
        q = int(o.get("quality") or 85)
        kw = {}
        if fmt in ("JPEG", "WEBP", "AVIF", "HEIF"):
            kw["quality"] = q
        if fmt == "JPEG":
            kw.update(optimize=True, progressive=True)
        if fmt == "PNG":
            kw["optimize"] = True
        if fmt == "TIFF":
            kw["compression"] = "tiff_lzw"
        if exif and fmt in ("JPEG", "WEBP", "TIFF", "PNG"):
            kw["exif"] = exif
        if icc and fmt in ("JPEG", "WEBP", "TIFF", "PNG"):
            kw["icc_profile"] = icc
        out = self.out_path(it, to, " (elaborata)")
        im.save(out, fmt, **kw)
        it["out"] = [out]
        before, after = it_size(src), it_size(out)
        return {"msg": f"{w0}x{h0} -> {im.size[0]}x{im.size[1]} · {_size(before)} -> {_size(after)}"}

    # ------------------------------------------------------------ video
    def _video(self, it, out=None):
        from . import media
        o = self.opts
        src = it["src"]
        out = out or self.out_path(it, "mp4", " (compresso)")
        crf = int(o.get("crf") or 26)
        maxh = int(o.get("max_h") or 0)
        info = media.probe(src)
        args = [media._ffmpeg(), "-y", "-hide_banner", "-i", src, "-map", "0:v:0?", "-map", "0:a:0?",
                "-c:v", "libx264", "-preset", o.get("preset") or "medium", "-crf", str(crf), "-pix_fmt", "yuv420p"]
        vf = []
        if maxh:
            vf.append(f"scale=-2:'min({maxh},ih)'")
        if o.get("fps"):
            vf.append(f"fps={int(o['fps'])}")
        if vf:
            args += ["-vf", ",".join(vf)]
        if o.get("mute"):
            args += ["-an"]
        else:
            args += ["-c:a", "aac", "-b:a", f"{int(o.get('audio_kbps') or 128)}k", "-ac", "2"]
        args += ["-movflags", "+faststart", out]
        self._ffmpeg(args, info.get("durata"))
        it["out"] = [out]
        return {"msg": f"{_size(it_size(src))} -> {_size(it_size(out))}"}

    def _ffmpeg(self, args, duration):
        import re
        proc = subprocess.Popen(args, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, creationflags=NO_WINDOW)
        self.proc = proc
        tail, buf = [], b""
        try:
            while True:
                chunk = proc.stderr.read(512)
                if not chunk:
                    break
                buf += chunk
                *lines, buf = re.split(rb"[\r\n]", buf)
                for line in lines:
                    s = line.decode("utf-8", "replace")
                    if s:
                        tail = (tail + [s])[-6:]
                    m = re.search(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", s)
                    if m and duration:
                        h, mi, sec = m.groups()
                        self.update(progress=(int(h) * 3600 + int(mi) * 60 + float(sec)) / duration)
            proc.wait()
        except Cancelled:
            proc.kill()
            proc.wait()
            raise
        finally:
            self.proc = None
        if self.cancelled:
            raise Cancelled()
        if proc.returncode != 0:
            raise RuntimeError("FFmpeg: " + " | ".join(tail[-3:]))

    # ------------------------------------------------------------ PDF unico
    def _merge(self, parts):
        import pymupdf
        o = self.opts
        name = (o.get("name") or "").strip() or "Unione"
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        folder = Path(self.dest) if self.mode == "cartella" else Path(self.items[0]["src"]).parent
        folder.mkdir(parents=True, exist_ok=True)
        out = folder / name
        if out.exists() and self.collision != "sovrascrivi":
            n = 1
            while (folder / f"{out.stem} ({n}).pdf").exists():
                n += 1
            out = folder / f"{out.stem} ({n}).pdf"
        res = pymupdf.open()
        toc = []
        for p, rel in parts:
            if self.cancelled:
                raise Cancelled()
            try:
                with pymupdf.open(p) as d:
                    if d.needs_pass:
                        continue
                    start = len(res)
                    res.insert_pdf(d)
                    toc.append([1, rel, start + 1])
            except Exception:  # noqa: BLE001
                continue
        if o.get("bookmarks", True):
            res.set_toc(toc)
        res.save(str(out), garbage=3, deflate=True)
        res.close()
        return str(out)

    # ------------------------------------------------------------ compiti della pagina (DWG, 3D)
    def _client(self, it, kind, extra) -> dict:
        self.task_seq += 1
        self.task_result = None
        self.task_event.clear()
        self.task = {"seq": self.task_seq, "kind": kind, "src": it["src"], "name": os.path.basename(it["src"]), "ext": Path(it["src"]).suffix.lower().lstrip("."), **extra}
        try:
            while not self.task_event.wait(0.5):
                if self.cancelled:
                    raise Cancelled()
                t = self.task or {}
                # la pagina interroga lo stato di continuo: se smette prima di prendere il compito, la finestra e' chiusa
                # o bloccata; una volta preso, il calcolo (es. IFC grandi) puo' durare a lungo
                limit = 1800 if t.get("taken") else 45
                if time.time() - max(self.last_poll, t.get("taken") or 0) > limit:
                    raise RuntimeError("La finestra di MB Visual non ha eseguito la conversione (chiusa o non risponde)")
            if self.cancelled:
                raise Cancelled()
            r = self.task_result or {}
            if r.get("errore"):
                raise RuntimeError(r["errore"])
            return r
        finally:
            self.task = None

    def client_take(self, seq):
        if self.task and self.task["seq"] == seq:
            self.task["taken"] = time.time()
            return True
        return False

    def client_done(self, seq, result: dict):
        if self.task and self.task["seq"] == seq:
            self.task_result = result
            self.task_event.set()
            return True
        return False

    # ------------------------------------------------------------ disegni CAD
    def _cad(self, it, to, out):
        doc = self._cad_doc(it)
        self.update(progress=0.5)
        if to == "dxf":
            doc.saveas(out)
            return {}
        return cad_render(doc, out, to, self.opts, update=self.update)

    def _cad_doc(self, it):
        import ezdxf
        from ezdxf import recover
        src = it["src"]
        if src.lower().endswith(".dxf"):
            try:
                return ezdxf.readfile(src)
            except Exception:  # noqa: BLE001
                doc, _ = recover.readfile(src)
                return doc
        from .cadedit import find_oda
        oda = find_oda()
        if oda:  # DWG -> DXF con ODA File Converter (fedele, tutti i fogli con le impostazioni di stampa)
            tin, tout = Path(tempfile.mkdtemp(dir=self.tmp)), Path(tempfile.mkdtemp(dir=self.tmp))
            shutil.copyfile(src, tin / "disegno.dwg")
            subprocess.run([oda, str(tin), str(tout), "ACAD2018", "DXF", "0", "1", "*.DWG"], capture_output=True, timeout=900, creationflags=NO_WINDOW)
            res = tout / "disegno.dxf"
            if res.exists():
                try:
                    return ezdxf.readfile(str(res))
                except Exception:  # noqa: BLE001
                    doc, _ = recover.readfile(str(res))
                    return doc
        db = self._client(it, "dwg", {}).get("db")
        if not db:
            raise RuntimeError("Il disegno DWG non e' stato letto")
        return doc_from_db(db)

    # ------------------------------------------------------------ rapporto
    def _write_report(self) -> str:
        stamp = datetime.now().strftime("%Y-%m-%d %H%M%S")
        name = f"Rapporto conversione {stamp}.csv"
        if self.mode == "cartella" and self.opts.get("report_file", True):
            path = Path(self.dest) / name
        else:
            d = TEMP_DIR / "lotti"
            d.mkdir(parents=True, exist_ok=True)
            path = d / name
        path.parent.mkdir(parents=True, exist_ok=True)
        stato = {"ok": "Riuscito", "errore": "Fallito", "saltato": "Saltato", "annullato": "Annullato", "attesa": "Non eseguito", "in corso": "Interrotto"}
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["File", "Esito", "Dettaglio", "Uscita", "Secondi"])
            for i in self.items:
                w.writerow([i["src"], stato.get(i["status"], i["status"]), i["msg"], " | ".join(i["out"]), str(i["t"]).replace(".", ",")])
            if self.merged:
                w.writerow([f"PDF unico ({sum(1 for i in self.items if i['status'] == 'ok')} file)", "Riuscito", "", self.merged, ""])
        return str(path)


class _Skip(Exception):
    pass


def it_size(p):
    try:
        return os.path.getsize(p)
    except OSError:
        return 0


def _size(n: int) -> str:
    for u in ("byte", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return f"{n:.0f} {u}" if u == "byte" else f"{n:.1f} {u}".replace(".", ",")
        n /= 1024
    return str(n)


def _reason(e: Exception) -> str:
    """Motivo leggibile per il rapporto (niente tracce di Python)."""
    msg = str(e) or e.__class__.__name__
    low = msg.lower()
    if isinstance(e, PermissionError) or "permission denied" in low or "access is denied" in low:
        return "Accesso negato: il file e' aperto in un altro programma o la cartella e' protetta"
    if isinstance(e, FileNotFoundError):
        return "File non trovato (spostato o eliminato durante la conversione)"
    if "password" in low or "encrypted" in low or "kennwort" in low:
        return "Il file e' protetto da password"
    if "failed to open" in low or "cannot open broken" in low or "no objects found" in low or "format error" in low:
        return "File danneggiato o non valido (il contenuto non corrisponde al tipo)"
    if "com_error" in low or "-2147" in low:
        return "Office non e' riuscito ad aprire il file (danneggiato, protetto o con finestre di dialogo): " + msg[-160:]
    return msg[:400]


# ---------------------------------------------------------------- DWG letto nella pagina -> documento ezdxf con i fogli
def doc_from_db(db: dict):
    """Database di libredwg (convertito nella pagina) -> documento ezdxf: modello, blocchi e fogli con le loro finestre."""
    from . import cadedit
    ltypes = [{"name": t.get("name"), "pattern": [float(p.get("elementLength") or 0) for p in (t.get("pattern") or [])], "description": t.get("description") or ""}
              for t in ((db.get("tables") or {}).get("LTYPE") or {}).get("entries", [])]
    doc, cx = cadedit._from_db(db, lambda d: cadedit.Ctx(d, ltypes))
    msp = doc.modelspace()
    brs = ((db.get("tables") or {}).get("BLOCK_RECORD") or {}).get("entries", [])
    paper = {b.get("handle"): b for b in brs if b.get("handle") and str(b.get("name", "")).lower().startswith("*paper_space")}
    by_owner: dict[str, list] = {}
    for e in db.get("entities") or []:
        owner = e.get("ownerBlockRecordSoftId")
        if e.get("isInPaperSpace") or owner in paper:
            by_owner.setdefault(owner, []).append(e)
            continue
        try:
            cadedit._create(msp, e, doc, cx)
        except Exception:  # noqa: BLE001
            pass
    # entita' dei fogli rimaste dentro il loro blocco (*Paper_Space0...)
    for h, b in paper.items():
        if b.get("entities") and not by_owner.get(h):
            by_owner[h] = list(b["entities"])
    layouts = (db.get("objects") or {}).get("LAYOUT") or []
    info = {L.get("paperSpaceTableId"): L for L in layouts if L.get("paperSpaceTableId")}
    order = sorted(by_owner, key=lambda h: (info.get(h, {}).get("tabOrder") or 999, h))
    made = []
    for h in order:
        ents = by_owner[h]
        L = info.get(h, {})
        name = str(L.get("layoutName") or f"Foglio {len(made) + 1}")[:200]
        base = name
        n = 1
        while name in doc.layouts:
            n += 1
            name = f"{base} ({n})"
        lay = doc.layouts.new(name)
        lay.dxf.taborder = len(made) + 1
        w, h_ = _paper_size(L, ents)
        try:
            lay.page_setup(size=(w, h_), margins=(0, 0, 0, 0), units="mm")
        except Exception:  # noqa: BLE001
            pass
        vps = sorted([e for e in ents if e.get("type") == "VIEWPORT"], key=lambda e: int(str(e.get("handle") or "0"), 16) if str(e.get("handle") or "").strip() else 0)
        overall = vps[0] if vps else None  # la prima finestra di ogni foglio e' il foglio stesso (non mostra il modello)
        for e in ents:
            if e.get("type") == "VIEWPORT":
                if e is overall:
                    continue
                _add_viewport(lay, e)
                continue
            try:
                cadedit._create(lay, e, doc, cx)
            except Exception:  # noqa: BLE001
                pass
        made.append(name)
    if made and "Layout1" in doc.layouts and "Layout1" not in made:
        try:
            doc.layouts.delete("Layout1")
        except Exception:  # noqa: BLE001
            pass
    return doc


def _xy(p, z=False):
    p = p or {}
    v = (float(p.get("x") or 0), float(p.get("y") or 0))
    return (*v, float(p.get("z") or 0)) if z else v


def _paper_size(L, ents):
    lo, hi = _xy(L.get("minLimit")), _xy(L.get("maxLimit"))
    w, h = hi[0] - lo[0], hi[1] - lo[1]
    if 50 < w < 5000 and 50 < h < 5000:
        return w, h
    return 420.0, 297.0


def _add_viewport(lay, e):
    w, h = float(e.get("width") or 0), float(e.get("height") or 0)
    if w <= 0 or h <= 0:
        return
    vh = float(e.get("viewHeight") or 0) or h
    try:
        vp = lay.add_viewport(center=_xy(e.get("viewportCenter"), True), size=(w, h), view_center_point=_xy(e.get("displayCenter")), view_height=vh)
        tw = e.get("viewTwistAngle")
        if tw:
            vp.dxf.view_twist_angle = float(tw) * 57.29577951308232 if abs(float(tw)) <= 6.3 else float(tw)
        if e.get("layer"):
            vp.dxf.layer = str(e["layer"])
        vp.dxf.status = 2
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- disegno -> PDF / SVG / PNG (ezdxf)
def _units_mm(doc) -> float:
    from ezdxf import units
    try:
        u = int(doc.header.get("$INSUNITS", 4) or 4)
        return float(units.conversion_factor(u, units.MM)) if u else 1.0
    except Exception:  # noqa: BLE001
        return 1.0


def _has_content(lay) -> bool:
    for e in lay:
        if e.dxftype() == "VIEWPORT" and int(e.dxf.get("id", 0) or 0) == 1:
            continue
        return True
    return False


def cad_layouts(doc, which: str) -> list:
    """Spazi da stampare: 'fogli' (layout con contenuto, altrimenti modello), 'modello', 'tutti'."""
    msp = doc.modelspace()
    sheets = [lay for lay in doc.layouts if not lay.is_modelspace and _has_content(lay)]
    sheets.sort(key=lambda lay: (lay.dxf.get("taborder", 0), lay.name))
    if which == "modello":
        return [msp]
    if which == "tutti":
        return [msp, *sheets]
    return sheets or [msp]


def _render_one(doc, lay, fmt, o):
    from ezdxf.addons.drawing import Frontend, RenderContext, layout
    from ezdxf.addons.drawing.config import BackgroundPolicy, ColorPolicy, Configuration, LineweightPolicy
    colors = {"colori": ColorPolicy.COLOR, "bn": ColorPolicy.BLACK, "grigi": ColorPolicy.MONOCHROME_LIGHT_BG}.get(o.get("colors") or "colori", ColorPolicy.COLOR)
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=colors,
                        lineweight_policy=LineweightPolicy.ABSOLUTE if o.get("lineweights", True) else LineweightPolicy.RELATIVE_FIXED)
    ctx = RenderContext(doc)
    ctx.set_current_layout(lay)
    if fmt == "svg":
        from ezdxf.addons.drawing.svg import SVGBackend
        backend = SVGBackend()
    else:
        from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend
        backend = PyMuPdfBackend()
    Frontend(ctx, backend, config=cfg).draw_layout(lay, finalize=True)
    margin = float(o.get("margin", 10) or 0)
    paper = (o.get("paper") or "auto").upper()
    orient = o.get("orient") or "auto"
    scale_n = float(o.get("scale") or 0)  # 0 = adatta al foglio; N = scala 1:N
    is_model = lay.is_modelspace
    page, settings = None, layout.Settings(fit_page=True)
    if paper == "AUTO" and not is_model:
        try:
            page = layout.Page.from_dxf_layout(lay)
            if page.width < 50 or page.height < 50:
                page = None
            else:
                settings = layout.Settings(fit_page=False, scale=1)
        except Exception:  # noqa: BLE001
            page = None
    if page is None:
        w, h = PAPER.get(paper, PAPER["A3"])
        page = layout.Page(w, h, layout.Units.mm, margins=layout.Margins.all(margin))
        if scale_n > 0 and is_model:
            settings = layout.Settings(fit_page=False, scale=_units_mm(doc) / scale_n)
    # orientamento: automatico = come il disegno
    if orient != "auto" or paper != "AUTO" or is_model:
        try:
            ext = _extents(lay)
            land = (ext[0] >= ext[1]) if orient == "auto" and ext else orient != "verticale"
        except Exception:  # noqa: BLE001
            land = orient != "verticale"
        page.to_landscape() if land else page.to_portrait()  # modificano la pagina sul posto
    if fmt == "svg":
        return backend.get_string(page, settings=settings).encode("utf-8")
    if fmt == "png":
        return backend.get_pixmap_bytes(page, fmt="png", dpi=int(o.get("dpi") or 200), settings=settings)
    return backend.get_pdf_bytes(page, settings=settings)


def _extents(lay):
    from ezdxf import bbox
    b = bbox.extents(lay, fast=True)
    if not b.has_data:
        return None
    return (b.size.x, b.size.y)


def cad_render(doc, out, fmt, o, update=None) -> dict:
    import pymupdf
    lays = cad_layouts(doc, o.get("layouts") or "fogli")
    names = [("Modello" if lay.is_modelspace else lay.name) for lay in lays]
    if fmt == "pdf":
        res = pymupdf.open()
        toc = []
        for i, lay in enumerate(lays):
            if update:
                update(progress=0.5 + 0.5 * i / max(len(lays), 1))
            data = _render_one(doc, lay, "pdf", o)
            with pymupdf.open("pdf", data) as d:
                toc.append([1, names[i], len(res) + 1])
                res.insert_pdf(d)
        if len(lays) > 1:
            res.set_toc(toc)
        res.save(out, garbage=3, deflate=True)
        res.close()
        return {"msg": f"{len(lays)} " + ("pagina: " if len(lays) == 1 else "pagine: ") + ", ".join(names)[:200]}
    # SVG / PNG: un file per spazio
    files = []
    for i, lay in enumerate(lays):
        if update:
            update(progress=0.5 + 0.5 * i / max(len(lays), 1))
        p = out if len(lays) == 1 else str(Path(out).with_name(f"{Path(out).stem} - {_safe(names[i])}{Path(out).suffix}"))
        Path(p).write_bytes(_render_one(doc, lay, fmt, o))
        files.append(p)
    return {"files": files, "msg": ", ".join(names)[:200]}


def _safe(s: str) -> str:
    return "".join("_" if c in '<>:"/\\|?*' else c for c in s).strip() or "foglio"


# ---------------------------------------------------------------- API (api/batch?op=...)
def handle(op: str, body: dict, q) -> dict:
    if op == "scan":
        return scan(body.get("paths") or [], bool(body.get("recursive", True)))
    if op == "start":
        b = Batch(body)
        with _LOCK:
            _BATCHES[b.id] = b
        threading.Thread(target=b.run, daemon=True, name="lotto-" + b.id).start()
        return {"ok": True, "id": b.id}
    if op == "list":
        return {"ok": True, "lotti": [b.state(False) for b in sorted(_BATCHES.values(), key=lambda b: -b.started)]}
    b = _BATCHES.get(q("id") or body.get("id") or "")
    if b is None:
        return {"ok": False, "errore": "Lotto sconosciuto"}
    if op == "status":
        b.last_poll = time.time()
        return b.state(q("full") != "0")
    if op == "cancel":
        b.cancel()
        return {"ok": True}
    if op == "take":
        return {"ok": b.client_take(int(body.get("seq") or 0))}
    if op == "client":
        return {"ok": b.client_done(int(body.get("seq") or 0), body.get("result") or {})}
    raise ValueError("operazione sconosciuta")
