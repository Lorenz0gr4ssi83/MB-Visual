"""Server HTTP locale (solo 127.0.0.1, protetto da token) che serve l'interfaccia e le API dei file."""
import json
import mimetypes
import os
import secrets
import shutil
import subprocess
import threading
import traceback
import uuid
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import archive, i18n, jobs, media, misc, office, signed
from .i18n import t
from .paths import TEMP_DIR, UI_DIR, find_navisworks, find_nwd2mbv, find_office, find_onlyoffice, find_trueview, tools_status

TOKEN = secrets.token_urlsafe(24)
COOKIE = "mbv"
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/json", ".json")
NO_WINDOW = 0x08000000


def _q(qs, name, default=None):
    v = qs.get(name)
    return v[0] if v else default


# attributi Windows dei file segnaposto di OneDrive (contenuto solo nel cloud, scaricato alla prima lettura)
_CLOUD_ATTRS = 0x400000 | 0x40000 | 0x1000  # RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE


def _solo_online(st) -> bool:
    return bool(getattr(st, "st_file_attributes", 0) & _CLOUD_ATTRS)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MBVisual"

    def log_message(self, fmt, *args):  # silenzioso
        pass

    def end_headers(self):
        # pagina "isolata" (COOP/COEP): richiesta dall'editor ONLYOFFICE incorporato, che usa WebAssembly a piu' thread
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    # ------------------------------------------------------------ helpers
    def _authorized(self, qs) -> bool:
        cookie = self.headers.get("Cookie", "")
        if f"{COOKIE}={TOKEN}" in cookie:
            return True
        return _q(qs, "t") == TOKEN

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8"))

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _body_json(self):
        b = self._body()
        return json.loads(b.decode("utf-8")) if b else {}

    def _serve_file(self, path: Path, ctype=None):
        if not path.is_file():
            return self._json({"ok": False, "errore": t("srv_server.file_non_trovato")}, 404)
        # il file si apre prima di rispondere: se non e' leggibile (es. download da OneDrive annullato) arriva un errore chiaro
        try:
            f = open(path, "rb")
        except OSError as e:
            return self._json({"ok": False, "errore": t("srv_server.file_non_leggibile_0", e.strerror or e)}, 409)
        with f:
            self._send_file(f, path, ctype)

    def _send_file(self, f, path: Path, ctype=None):
        size = path.stat().st_size
        ctype = ctype or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        code = 200
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].partition("-")
            if a:
                start = int(a)
                end = int(b) if b else size - 1
            else:
                start = max(0, size - int(b))
            end = min(end, size - 1)
            code = 206
        length = max(0, end - start + 1)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        f.seek(start)
        left = length
        while left > 0:
            try:
                chunk = f.read(min(1024 * 1024, left))
            except OSError:
                return  # lettura interrotta (es. download da OneDrive annullato): la risposta resta incompleta
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                return
            left -= len(chunk)

    # ------------------------------------------------------------ routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def _route(self, method):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        route = u.path
        # lingua dell'interfaccia: vale per i messaggi di questa richiesta e dei lavori che avvia (mbvisual/i18n.py)
        i18n.set_language(self.headers.get("X-MBV-Lang"))
        try:
            if not route.startswith("/api/"):
                return self._static(route, qs)
            if not self._authorized(qs):
                self.close_connection = True  # corpo della POST non letto: la connessione non si riusa (prima la richiesta dopo dava 501)
                return self._json({"ok": False, "errore": t("srv_server.non_autorizzato")}, 403)
            fn = getattr(self, "api_" + route[5:].replace("/", "_").replace("-", "_"), None)
            if fn is None:
                return self._json({"ok": False, "errore": t("srv_server.api_sconosciuta")}, 404)
            # licenza: senza attivazione valida rispondono solo licenza e aggiornamenti (mbvisual/license.py)
            if not route.startswith(("/api/license", "/api/update", "/api/job")):
                from . import license as lic
                if lic.required() and not lic.status().get("attiva"):
                    return self._json({"ok": False, "errore": t("srv_server.licenza_non_attiva"), "licenza": True}, 402)
            fn(qs)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._json({"ok": False, "errore": str(e) or e.__class__.__name__}, 500)
            except Exception:
                pass

    def _static(self, route, qs):
        extra = {}
        if route in ("/", "/index.html"):
            if _q(qs, "t") == TOKEN:
                extra["Set-Cookie"] = f"{COOKIE}={TOKEN}; Path=/; SameSite=Strict; HttpOnly"
            elif not self._authorized(qs):
                return self._send(403, b"Accesso negato", "text/plain")
            route = "/index.html"
        p = (UI_DIR / unquote(route).lstrip("/")).resolve()
        if not str(p).startswith(str(UI_DIR.resolve())) or not p.is_file():
            return self._send(404, b"Non trovato", "text/plain")
        if extra:
            data = p.read_bytes()
            return self._send(200, data, "text/html; charset=utf-8", extra)
        self._serve_file(p)

    # ------------------------------------------------------------ API: lingua (ui/js/i18n.js)
    def api_lang(self, qs):
        self._json({"ok": True, "windows": i18n.windows_language(), "lingua": i18n.language()})

    # ------------------------------------------------------------ API: aggiornamento automatico (mbvisual/update.py)
    # ------------------------------------------------------------ API: licenza (mbvisual/license.py)
    def api_license_status(self, qs):
        from . import license as lic
        self._json(lic.status(force=_q(qs, "force") == "1"))

    def api_license_activate(self, qs):
        from . import license as lic
        self._json(lic.activate(str(self._body_json().get("key", ""))))

    def api_license_account(self, qs):
        from . import license as lic
        self._json(lic.account())

    def api_license_request(self, qs):
        from . import license as lic
        b = self._body_json()
        self._json(lic.request(b.get("type", "report"), str(b.get("message", "")), str(b.get("key", ""))))

    # ------------------------------------------------------------ API: motore IA (mbvisual/ia.py -> ia/engine.py)
    def api_ia_status(self, qs):
        from . import ia
        self._json(ia.status())

    def api_ia_put(self, qs):
        from . import ia
        self._json({"ok": True, "path": ia.put(self._body())})

    def api_ia_cancel(self, qs):
        from . import ia
        ia.cancel(_q(qs, "id", ""))
        self._json({"ok": True})

    def api_ia_run(self, qs):
        from . import ia
        b = self._body_json()
        for k in ("image", "mask"):  # solo file passati dall'app (cartella temporanea dell'IA)
            if b.get(k) and not str(Path(b[k]).resolve()).startswith(str(ia.OUT.resolve())):
                raise ValueError(t("srv_server.percorso_non_consentito"))
        self._json({"ok": True, "job": jobs.start(ia.run, b)})

    # ------------------------------------------------------------ API: archivi cloud (mbvisual/cloud.py, ui/js/cloud.js)
    def api_cloud(self, qs):
        from . import cloud
        b = self._body_json() if self.command == "POST" else {}
        self._json(cloud.handle(_q(qs, "op", ""), {k: v[0] for k, v in qs.items()}, b))

    def api_update_check(self, qs):
        from . import update
        self._json(update.check())

    def api_update_apply(self, qs):
        from . import update
        self._json({"ok": True, "job": jobs.start(update.apply)})

    def api_update_install(self, qs):
        from . import update
        self._json({"ok": True, "job": jobs.start(update.install)})

    def api_update_source(self, qs):
        from . import update
        self._json(update.set_source(_q(qs, "folder") or ""))

    # ------------------------------------------------------------ API: file generici
    def _path(self, qs) -> str:
        p = _q(qs, "path")
        if not p:
            raise ValueError(t("srv_server.percorso_mancante"))
        return os.path.abspath(p)

    def api_file(self, qs):
        self._serve_file(Path(self._path(qs)), _q(qs, "type"))

    def api_info(self, qs):
        p = Path(self._path(qs))
        st = p.stat()
        base = {"ok": True, "path": str(p), "nome": p.name, "cartella": str(p.parent), "size": st.st_size,
                "modificato": st.st_mtime, "creato": st.st_ctime, "scrivibile": os.access(p, os.W_OK)}
        if _solo_online(st):
            # file solo su OneDrive: leggerlo fa partire il download. Senza conferma non si legge nulla;
            # con la conferma, se l'utente annulla il download la lettura fallisce e l'apertura si ferma qui.
            if _q(qs, "scarica") != "1":
                return self._json({**base, "nuvola": True, "sniff": {"kind": None, "descr": None}})
            try:
                with open(p, "rb") as f:
                    f.read(1)
            except OSError:
                return self._json({"ok": False, "errore": t("srv_server.download_onedrive_annullato_non_riuscito")}, 409)
        self._json({**base, "sniff": misc.sniff(str(p))})

    # ------------------------------------------------------------ disegni CAD modificati
    def api_cad_save(self, qs):
        from . import cadedit
        b = self._body_json()
        self._json(cadedit.save(self._path(qs), b["out"], b.get("edits") or {}))

    # ------------------------------------------------------------ "Salva con nome" in altri formati
    def api_convert_targets(self, qs):
        from . import convert
        self._json(convert.targets(self._path(qs)))

    def api_convert(self, qs):
        from . import convert
        out = self._body_json()["out"]
        self._json({"ok": True, "job": jobs.start(convert.convert, self._path(qs), out)})

    def api_temp_path(self, qs):
        # percorso temporaneo per salvare lo stato attuale di un documento prima di convertirlo
        d = TEMP_DIR / "conversioni" / uuid.uuid4().hex[:8]
        d.mkdir(parents=True, exist_ok=True)
        self._json({"ok": True, "path": str(d / Path(_q(qs, "name", "file")).name)})

    def api_nwd_convert(self, qs):
        # Navisworks senza Navisworks: nwd2mbv scrive gerarchia/proprieta' (json) e geometria (bin) in una cache
        import hashlib
        p = self._path(qs)
        exe = find_nwd2mbv()
        if not exe:
            raise RuntimeError(t("srv_server.lettore_navisworks_non_incluso_questa"))
        st = os.stat(p)
        # nella chiave anche la data del lettore: un lettore aggiornato rifa' la conversione
        key = hashlib.sha1(f"{p}|{st.st_size}|{st.st_mtime}|{os.path.getmtime(exe)}".encode()).hexdigest()[:16]
        out = TEMP_DIR / "navisworks" / key
        out.mkdir(parents=True, exist_ok=True)
        prefix = out / "modello"
        if not (prefix.with_suffix(".json")).exists():
            r = subprocess.run([exe, p, str(prefix)], capture_output=True, timeout=1800, creationflags=NO_WINDOW)
            if r.returncode != 0 or not prefix.with_suffix(".json").exists():
                msg = (r.stderr or r.stdout).decode("utf-8", "replace").strip()[-400:]
                raise RuntimeError(t("srv_server.lettura_file_navisworks_non_riuscita") + (msg or f"codice {r.returncode}"))
        self._json({"ok": True, "json": str(prefix.with_suffix(".json")), "bin": str(prefix.with_suffix(".bin"))})

    def api_onlyoffice(self, qs):
        self._json({"ok": True, "url": onlyoffice_url()})

    def api_stat(self, qs):
        # solo data e dimensione (senza leggere il file): serve ad accorgersi delle modifiche fatte da altri programmi
        st = os.stat(self._path(qs))
        self._json({"ok": True, "size": st.st_size, "modificato": st.st_mtime})

    def api_list_dir(self, qs):
        d = Path(self._path(qs))
        items = []
        for e in os.scandir(d):
            try:
                if e.name.startswith(("~$", ".")) or e.name.lower() in ("desktop.ini", "thumbs.db"):
                    continue
                st = e.stat()
                items.append({"name": e.name, "path": e.path, "dir": e.is_dir(), "size": 0 if e.is_dir() else st.st_size, "mtime": st.st_mtime,
                              "nuvola": not e.is_dir() and _solo_online(st)})
            except OSError:
                continue
        items.sort(key=lambda i: (not i["dir"], i["name"].lower()))
        self._json({"ok": True, "path": str(d), "items": items})

    def api_file_hash(self, qs):
        import hashlib
        h = hashlib.sha256()
        with open(self._path(qs), "rb") as f:
            for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
                h.update(chunk)
        self._json({"ok": True, "sha256": h.hexdigest()})

    def api_tools(self, qs):
        self._json({"ok": True, "tools": {k: bool(v) for k, v in tools_status().items()}})

    def api_save(self, qs):
        """Scrive il corpo della richiesta nel file (con copia di sicurezza temporanea)."""
        p = Path(self._path(qs))
        data = self._body()
        if p.exists() and _q(qs, "backup", "1") == "1":
            bdir = TEMP_DIR / "backup"
            bdir.mkdir(exist_ok=True)
            shutil.copy2(p, bdir / f"{uuid.uuid4().hex[:6]}_{p.name}")
        tmp = p.with_name(p.name + ".mbv-tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
        self._json({"ok": True, "path": str(p), "size": len(data)})

    def api_patch(self, qs):
        """Modifica byte in posizione: [{offset, hex}] (editor esadecimale)."""
        p = Path(self._path(qs))
        patches = self._body_json().get("patches", [])
        with open(p, "r+b") as f:
            for pt in patches:
                f.seek(int(pt["offset"]))
                f.write(bytes.fromhex(pt["hex"]))
        self._json({"ok": True})

    def api_upload(self, qs):
        """Ripiego per il trascinamento senza percorso: salva il file in una cartella temporanea."""
        name = os.path.basename(_q(qs, "name", "file"))
        d = TEMP_DIR / "caricati" / uuid.uuid4().hex[:8]
        d.mkdir(parents=True, exist_ok=True)
        p = d / name
        p.write_bytes(self._body())
        self._json({"ok": True, "path": str(p)})

    def api_temp_path(self, qs):
        name = os.path.basename(_q(qs, "name", "file"))
        d = TEMP_DIR / "nuovi" / uuid.uuid4().hex[:8]
        d.mkdir(parents=True, exist_ok=True)
        self._json({"ok": True, "path": str(d / name)})

    def api_strings(self, qs):
        self._json({"ok": True, "strings": misc.strings(self._path(qs))})

    def api_reveal(self, qs):
        subprocess.Popen(["explorer", "/select,", self._path(qs)])
        self._json({"ok": True})

    def api_open_external(self, qs):
        p = self._path(qs)
        app = _q(qs, "app")
        exe = {"navisworks": find_navisworks, "trueview": find_trueview, "excel": lambda: find_office("excel.exe"),
               "word": lambda: find_office("winword.exe"), "powerpoint": lambda: find_office("powerpnt.exe")}.get(app, lambda: None)()
        if app and not exe:
            return self._json({"ok": False, "errore": t("srv_server.programma_non_installato_questo_pc")})
        if exe:
            subprocess.Popen([exe, p])
        else:
            os.startfile(p)  # noqa: S606 - programma predefinito di Windows
        self._json({"ok": True})

    def api_job(self, qs):
        j = jobs.get(_q(qs, "id", ""))
        self._json({"ok": j is not None, **(j or {"errore": t("srv_server.lavoro_sconosciuto")})})

    # ------------------------------------------------------------ testo
    def api_text(self, qs):
        self._json(misc.read_text(self._path(qs)))

    def api_text_save(self, qs):
        b = self._body_json()
        self._json(misc.write_text(self._path(qs), b["text"], b.get("encoding", "utf-8"), b.get("bom", False), b.get("eol", "\n")))

    # ------------------------------------------------------------ immagini
    def api_image(self, qs):
        self._json({"ok": True, **misc.image_to_png(self._path(qs))})

    def api_image_save(self, qs):
        self._json(misc.save_image(self._body(), self._path(qs), int(_q(qs, "quality", "92"))))

    # ------------------------------------------------------------ media
    def api_media_probe(self, qs):
        self._json({"ok": True, **media.probe(self._path(qs))})

    def api_media_playable(self, qs):
        self._json({"ok": True, "job": jobs.start(media.playable, self._path(qs))})

    def api_media_edit(self, qs):
        b = self._body_json()
        self._json({"ok": True, "job": jobs.start(media.edit, self._path(qs), b["out"], b.get("start"), b.get("end"),
                                                  int(b.get("rotate", 0)), bool(b.get("mute")), bool(b.get("audio_only")),
                                                  b.get("volume"))})

    def api_media_frame(self, qs):
        b = self._body_json()
        self._json({"ok": True, "path": media.frame(self._path(qs), float(b["t"]), b["out"])})

    def api_media_waveform(self, qs):
        self._json({"ok": True, "peaks": media.waveform(self._path(qs))})

    # ------------------------------------------------------------ montaggio video (mbvisual/video.py, ui/js/videdit.js)
    def api_video_info(self, qs):
        from . import video
        self._json({"ok": True, **video.info(self._path(qs))})

    def api_video_waveform(self, qs):
        from . import video
        self._json({"ok": True, **video.waveform(self._path(qs), int(_q(qs, "rate", "100")))})

    def api_video_thumbs(self, qs):
        from . import video
        self._json({"ok": True, "job": jobs.start(video.thumbs, self._path(qs), int(_q(qs, "h", "54")))})

    def api_video_peak(self, qs):
        from . import video
        b = self._body_json()
        self._json({"ok": True, **video.peak(self._path(qs), float(b.get("start") or 0), b.get("dur"))})

    def api_video_stabilize(self, qs):
        from . import video
        b = self._body_json()
        self._json({"ok": True, "job": jobs.start(video.stabilize, self._path(qs), b["out"], int(b.get("smooth", 15)))})

    def api_video_export(self, qs):
        from . import video
        b = self._body_json()
        self._json({"ok": True, "job": jobs.start(video.export, b["project"], b["out"], b.get("opts") or {})})

    # ------------------------------------------------------------ firme
    def api_signed(self, qs):
        self._json(signed.open_signed(self._path(qs)))

    def api_pdf_tool(self, qs):
        from . import pdftools
        b = self._body_json()
        op = _q(qs, "op")
        p = self._path(qs)
        if op == "merge":
            r = pdftools.merge([p, *b.get("others", [])], b["out"])
        elif op == "extract":
            r = pdftools.extract(p, b["pages"], b["out"])
        elif op == "delete":
            r = pdftools.delete(p, b["pages"], b["out"])
        elif op == "rotate":
            r = pdftools.rotate(p, b.get("pages", ""), int(b.get("angle", 90)), b["out"])
        elif op == "split":
            r = pdftools.split(p, b["folder"])
        elif op == "stamp":
            r = pdftools.stamp(p, b["text"], b.get("mode", "filigrana"), b["out"], b.get("pages", ""), float(b.get("opacity", 0.25)))
        else:
            return self._pdf_edit_op(op, p, b)
        self._json(r)

    def _pdf_edit_op(self, op, p, b):
        from . import pdfedit
        if op == "ocr":  # lungo: lavoro in background con avanzamento
            return self._json({"ok": True, "job": jobs.start(pdfedit.ocr, p, b["out"])})
        if op == "compress":
            r = pdfedit.compress(p, b["out"], int(b.get("dpi", 150)), int(b.get("quality", 75)))
        elif op == "protect":
            r = pdfedit.protect(p, b["out"], b["password"], b.get("owner", ""), bool(b.get("print", True)), bool(b.get("copy", False)), bool(b.get("edit", False)))
        elif op == "unlock":
            r = pdfedit.unlock(p, b["out"], b.get("password", ""))
        elif op == "numbers":
            r = pdfedit.page_numbers(p, b["out"], b.get("format", t("srv_server.pagina_n_tot")), b.get("pos", "basso-destra"), int(b.get("start", 1)))
        elif op == "word":
            r = pdfedit.to_word(p, b["out"])
        elif op == "images":
            r = pdfedit.to_images(p, b["folder"], int(b.get("dpi", 150)), b.get("format", "png"))
        elif op == "blank":
            r = pdfedit.insert_blank(p, b["out"], int(b.get("after", 0)))
        elif op == "reorder":
            r = pdfedit.reorder(p, b["out"], b["order"])
        else:
            raise ValueError(t("srv_server.operazione_sconosciuta"))
        self._json(r)

    # ------------------------------------------------------------ editor PDF (copia di lavoro modificabile)
    def api_pdf_work(self, qs):
        from . import pdfedit
        self._json({"ok": True, "path": pdfedit.working_copy(self._path(qs), TEMP_DIR / "pdf-modifica")})

    def api_pdf_objects(self, qs):
        from . import pdfobjects
        self._json(pdfobjects.page_objects(self._path(qs), int(_q(qs, "page", "0"))))

    def api_pdf_ops(self, qs):
        from . import pdfobjects
        p = self._path(qs)
        if not str(Path(p).resolve()).startswith(str((TEMP_DIR / "pdf-modifica").resolve())):
            raise ValueError(t("srv_server.modifiche_si_applicano_solo_copia"))
        self._json(pdfobjects.apply_ops(p, self._body_json().get("ops", [])))

    def api_pdf_lines(self, qs):
        from . import pdfedit
        self._json(pdfedit.text_lines(self._path(qs), int(_q(qs, "page", "0"))))

    def api_pdf_edit(self, qs):
        from . import pdfedit
        p = self._path(qs)
        if not str(Path(p).resolve()).startswith(str((TEMP_DIR / "pdf-modifica").resolve())):
            raise ValueError(t("srv_server.modifiche_si_applicano_solo_copia"))
        self._json(pdfedit.apply_edits(p, self._body_json().get("edits", [])))

    def api_pdf_signatures(self, qs):
        self._json(signed.pdf_signatures(self._path(qs)))

    def api_firma(self, qs):
        # firma digitale (mbvisual/firma.py, ui/js/firma.js): certificati, impostazioni, anteprima; firma = lavoro in background
        from . import firma
        op, b = _q(qs, "op"), self._body_json()
        if op in ("pades", "cades"):
            fn = firma.sign_pdf if op == "pades" else firma.sign_cades
            return self._json({"ok": True, "job": jobs.start(fn, b["path"], b["out"], b)})
        self._json(firma.run(op, b))

    # ------------------------------------------------------------ pubblicazioni (editor in stile Publisher)
    def api_pub_pdf(self, qs):
        from . import publisher
        self._json(publisher.export_pdf(self._body(), self._path(qs)))

    def api_pub_import(self, qs):
        from . import publisher
        self._json({"ok": True, "job": jobs.start(publisher.import_pub, self._path(qs))})

    # ------------------------------------------------------------ archivi
    def api_archive_list(self, qs):
        self._json(archive.list_entries(self._path(qs), _q(qs, "password")))

    def api_archive_extract(self, qs):
        b = self._body_json()
        self._json({"ok": True, "path": archive.extract(self._path(qs), b.get("entry"), b.get("dest"), b.get("password"))})

    def api_archive_add(self, qs):
        b = self._body_json()
        archive.add_files(self._path(qs), b.get("files", []), b.get("folder", ""))
        self._json({"ok": True})

    def api_archive_delete(self, qs):
        archive.delete_entries(self._path(qs), self._body_json().get("entries", []))
        self._json({"ok": True})

    def api_archive_rename(self, qs):
        b = self._body_json()
        archive.rename_entry(self._path(qs), b["old"], b["new"])
        self._json({"ok": True})

    # ------------------------------------------------------------ office
    def api_office_convert(self, qs):
        self._json({"ok": True, "job": jobs.start(office.lo_convert, self._path(qs), _q(qs, "to", "pdf"))})

    def api_pptx(self, qs):
        self._json(office.read_pptx(self._path(qs)))

    def api_pptx_save(self, qs):
        b = self._body_json()
        self._json(office.save_pptx(self._path(qs), b.get("out") or self._path(qs), b.get("edits", [])))

    def api_docx_save(self, qs):
        b = self._body_json()
        self._json(office.save_docx_from_html(b["html"], self._path(qs), b.get("title", "")))

    # ------------------------------------------------------------ email / sqlite
    def api_email(self, qs):
        self._json(misc.read_email(self._path(qs)))

    def api_sqlite_schema(self, qs):
        self._json(misc.sqlite_schema(self._path(qs)))

    def api_sqlite_query(self, qs):
        b = self._body_json()
        self._json(misc.sqlite_query(self._path(qs), b["sql"], b.get("params"), int(b.get("limit", 1000)), bool(b.get("write"))))


# ---------------------------------------------------------------- ONLYOFFICE (editor Word/Excel/PowerPoint integrato)
# Gira su un secondo server locale, con un indirizzo suo: il suo service worker e la sua cache restano separati da
# MB Visual. Le intestazioni COOP/COEP/CORP permettono di incorporarlo nelle schede come pagina isolata.
_OO = {"port": None, "lock": threading.Lock()}


class OOHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silenzioso
        pass

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-cache" if self.path.split("?")[0].endswith((".html", "sw.js", "/")) else "max-age=86400")
        if self.path.split("?")[0].endswith(".br"):
            self.send_header("Content-Encoding", "br")  # file gia' compresso (es. x2t.wasm.br): lo decomprime il browser
        super().end_headers()

    def guess_type(self, path):
        return super().guess_type(path[:-3] if str(path).endswith(".br") else path)

    def send_head(self):
        p = self.path.split("?", 1)
        if p[0] in ("/editor", "/editor/"):
            self.path = "/editor.html" + ("?" + p[1] if len(p) > 1 else "")
            p[0] = "/editor.html"
        if p[0] == "/editor.html":
            return self._editor_page()
        return super().send_head()

    # la pagina dell'editor riceve uno script di MB Visual: segnala le modifiche non salvate (l'indicatore interno
    # dell'editor senza server non si aggiorna) e mantiene il puntatore a freccia
    _INJECT = b"""<style>*,*::before,*::after{cursor:default!important}</style><script>
(function(){var last=null,base=null;function win(){try{var f=document.querySelector('iframe[name="frameEditor"]')||document.querySelector('iframe');return f&&f.contentWindow;}catch(e){return null;}}
function ed(){var w=win();return w&&(w.editor||(w.Asc&&w.Asc.editor));}
function hist(){try{var w=win(),h=w&&w.AscCommon&&w.AscCommon.History;return h&&typeof h.Index==='number'?h.Index:null;}catch(e){return null;}}
var edits=0,NAV=/^(Arrow|Page|Home|End|Shift|Control|Alt|Meta|Escape|Tab|F\\d|CapsLock|NumLock|ContextMenu)/;
function hook(){var w=win();if(!w||w.__mbv)return;try{var d=w.document;w.__mbv=1;
d.addEventListener('keydown',function(k){if(!NAV.test(k.key)&&!(k.ctrlKey&&/^[acfp]$/i.test(k.key)))edits++;},true);
['paste','cut','drop'].forEach(function(t){d.addEventListener(t,function(){edits++;},true);});
d.addEventListener('mousedown',function(m){var t=m.target;if(t&&t.closest&&t.closest('#toolbar,.toolbar,.dropdown-menu,.asc-window'))edits++;},true);}catch(x){}}
setInterval(function(){var e=ed();if(!e)return;hook();var flag=true;
try{if(e.asc_isDocumentModified||e.isDocumentModified)flag=!!(e.asc_isDocumentModified?e.asc_isDocumentModified():e.isDocumentModified());}catch(x){}
var m=edits>0&&flag;
if(m!==last){last=m;parent.postMessage({type:'mbv:dirty',payload:{dirty:m}},'*');}
try{var d=document.querySelector('iframe').contentDocument;if(d&&!d.getElementById('mbv-arrow')){var s=d.createElement('style');s.id='mbv-arrow';s.textContent='*,*::before,*::after{cursor:default!important}';d.head.appendChild(s);}}catch(x){}},1200);
addEventListener('message',function(ev){if(ev.source===parent&&ev.data&&ev.data.type==='mbv:diag'){var w=win(),h=w&&w.AscCommon&&w.AscCommon.History,e2=ed(),o={};
try{o.hasHist=!!h;o.index=h&&h.Index;o.points=h&&h.Points&&h.Points.length;o.histKeys=h&&Object.keys(h).slice(0,30);o.wHist=!!(w&&w.History);o.wIndex=w&&w.History&&w.History.Index;
o.mod=e2&&(e2.asc_isDocumentModified?e2.asc_isDocumentModified():e2.isDocumentModified&&e2.isDocumentModified());o.canUndo=e2&&e2.asc_getCanUndo&&e2.asc_getCanUndo();}catch(x){o.err=String(x);}
parent.postMessage({type:'mbv:diag',payload:o},'*');return;}
if(ev.source!==parent||!ev.data||ev.data.type!=='mbv:saved')return;var e=ed();
edits=0;try{e.setDocumentModified?e.setDocumentModified(false):e.asc_setDocumentModified&&e.asc_setDocumentModified(false);}catch(x){}last=false;});})();
</script>"""

    def _editor_page(self):
        import io
        f = Path(self.directory) / "editor.html"
        data = f.read_bytes().replace(b"</head>", self._INJECT + b"</head>", 1)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        return io.BytesIO(data)


def onlyoffice_url() -> str:
    d = find_onlyoffice()
    if not d:
        raise RuntimeError(t("srv_server.l_editor_onlyoffice_non_incluso"))
    with _OO["lock"]:
        if not _OO["port"]:
            srv = ThreadingHTTPServer(("127.0.0.1", 0), partial(OOHandler, directory=str(d)))
            srv.daemon_threads = True
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            _OO["port"] = srv.server_address[1]
    return f"http://127.0.0.1:{_OO['port']}"


def start_server(port: int = 0) -> tuple[ThreadingHTTPServer, int]:
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]
