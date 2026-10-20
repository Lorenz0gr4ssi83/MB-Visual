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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import archive, jobs, media, misc, office, signed
from .paths import TEMP_DIR, UI_DIR, find_navisworks, find_trueview, tools_status

TOKEN = secrets.token_urlsafe(24)
COOKIE = "mbv"
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/json", ".json")
NO_WINDOW = 0x08000000


def _q(qs, name, default=None):
    v = qs.get(name)
    return v[0] if v else default


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MBVisual"

    def log_message(self, fmt, *args):  # silenzioso
        pass

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
            return self._json({"ok": False, "errore": "File non trovato"}, 404)
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
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1024 * 1024, left))
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
        try:
            if not route.startswith("/api/"):
                return self._static(route, qs)
            if not self._authorized(qs):
                return self._json({"ok": False, "errore": "non autorizzato"}, 403)
            fn = getattr(self, "api_" + route[5:].replace("/", "_").replace("-", "_"), None)
            if fn is None:
                return self._json({"ok": False, "errore": "API sconosciuta"}, 404)
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

    # ------------------------------------------------------------ API: file generici
    def _path(self, qs) -> str:
        p = _q(qs, "path")
        if not p:
            raise ValueError("percorso mancante")
        return os.path.abspath(p)

    def api_file(self, qs):
        self._serve_file(Path(self._path(qs)), _q(qs, "type"))

    def api_info(self, qs):
        p = Path(self._path(qs))
        st = p.stat()
        self._json({"ok": True, "path": str(p), "nome": p.name, "cartella": str(p.parent), "size": st.st_size,
                    "modificato": st.st_mtime, "creato": st.st_ctime, "sniff": misc.sniff(str(p)),
                    "scrivibile": os.access(p, os.W_OK)})

    def api_list_dir(self, qs):
        d = Path(self._path(qs))
        items = []
        for e in os.scandir(d):
            try:
                if e.name.startswith(("~$", ".")) or e.name.lower() in ("desktop.ini", "thumbs.db"):
                    continue
                st = e.stat()
                items.append({"name": e.name, "path": e.path, "dir": e.is_dir(), "size": 0 if e.is_dir() else st.st_size, "mtime": st.st_mtime})
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
        exe = {"navisworks": find_navisworks, "trueview": find_trueview}.get(app, lambda: None)()
        if app and not exe:
            return self._json({"ok": False, "errore": "Programma non installato su questo PC"})
        if exe:
            subprocess.Popen([exe, p])
        else:
            os.startfile(p)  # noqa: S606 - programma predefinito di Windows
        self._json({"ok": True})

    def api_job(self, qs):
        j = jobs.get(_q(qs, "id", ""))
        self._json({"ok": j is not None, **(j or {"errore": "lavoro sconosciuto"})})

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
            raise ValueError("operazione sconosciuta")
        self._json(r)

    def api_pdf_signatures(self, qs):
        self._json(signed.pdf_signatures(self._path(qs)))

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


def start_server(port: int = 0) -> tuple[ThreadingHTTPServer, int]:
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]
