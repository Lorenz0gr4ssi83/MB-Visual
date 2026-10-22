"""Archivi tramite 7-Zip (incluso nell'app) con ripiego su zipfile/tarfile di Python."""
import shutil
import subprocess
import tarfile
import uuid
import zipfile
from pathlib import Path

from .paths import NO_WINDOW, TEMP_DIR, find_7zip
from .i18n import t as tr

EDITABLE = {".zip", ".7z", ".tar", ".wim", ".jar", ".war", ".ear", ".xpi", ".cbz", ".cb7", ".zipx", ".apk",
            ".nupkg", ".vsix", ".whl", ".egg", ".kmz", ".ova"}


def _run7z(args, cwd=None):
    exe = find_7zip()
    if not exe:
        raise RuntimeError(tr("srv_archive.7_zip_non_trovato"))
    r = subprocess.run([exe, *args], capture_output=True, cwd=cwd, creationflags=NO_WINDOW)
    out = r.stdout.decode("utf-8", "replace")
    if r.returncode not in (0, 1):
        raise RuntimeError((r.stderr.decode("utf-8", "replace") or out).strip()[-800:])
    return out


def list_entries(path: str, password: str | None = None) -> dict:
    exe = find_7zip()
    if exe:
        args = ["l", "-slt", "-sccUTF-8", "-p" + (password or ""), path]
        out = _run7z(args)
        entries, cur, started = [], {}, False
        for line in out.splitlines():
            if line.startswith("----------"):
                started = True
                continue
            if not started:
                continue
            if not line.strip():
                if cur.get("Path"):
                    entries.append(cur)
                cur = {}
                continue
            if " = " in line:
                k, v = line.split(" = ", 1)
                cur[k] = v
        if cur.get("Path"):
            entries.append(cur)
        items = [{"path": e["Path"].replace("\\", "/"), "dir": e.get("Folder") == "+" or "D" in e.get("Attributes", "")[:1],
                  "size": int(e.get("Size") or 0), "packed": int(e.get("Packed Size") or 0),
                  "modified": e.get("Modified", ""), "encrypted": e.get("Encrypted") == "+"} for e in entries]
        tm = None
        for line in out.splitlines():
            if line.startswith("Type = "):
                tm = line.split(" = ", 1)[1]
                break
        return {"ok": True, "items": items, "type": tm, "editable": Path(path).suffix.lower() in EDITABLE}
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            items = [{"path": i.filename.rstrip("/"), "dir": i.is_dir(), "size": i.file_size, "packed": i.compress_size,
                      "modified": "%04d-%02d-%02d %02d:%02d" % i.date_time[:5], "encrypted": bool(i.flag_bits & 1)} for i in z.infolist()]
        return {"ok": True, "items": items, "type": "zip", "editable": True}
    if tarfile.is_tarfile(path):
        with tarfile.open(path) as t:
            items = [{"path": m.name, "dir": m.isdir(), "size": m.size, "packed": m.size, "modified": "", "encrypted": False} for m in t.getmembers()]
        return {"ok": True, "items": items, "type": "tar", "editable": False}
    return {"ok": False, "errore": tr("srv_archive.formato_archivio_non_riconosciuto")}


def extract(path: str, entry: str | None = None, dest: str | None = None, password: str | None = None) -> str:
    """Estrae un elemento (o tutto) e ritorna il percorso estratto."""
    out_dir = Path(dest) if dest else TEMP_DIR / "archivi" / uuid.uuid4().hex[:8]
    out_dir.mkdir(parents=True, exist_ok=True)
    if find_7zip():
        args = ["x", "-y", "-sccUTF-8", "-p" + (password or ""), "-o" + str(out_dir), path]
        if entry:
            args.append(entry.replace("/", "\\"))
        _run7z(args)
    elif zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            if entry:
                z.extract(entry, out_dir)
            else:
                z.extractall(out_dir)
    else:
        with tarfile.open(path) as t:
            members = [t.getmember(entry)] if entry else None
            t.extractall(out_dir, members=members, filter="data")
    if entry:
        return str(out_dir / entry)
    return str(out_dir)


def add_files(path: str, files: list[str], folder: str = "") -> None:
    """Aggiunge file all'archivio (dentro 'folder' se indicato)."""
    if not files:
        return
    if folder:
        stage = TEMP_DIR / "aggiunte" / uuid.uuid4().hex[:8]
        target = stage / folder
        target.mkdir(parents=True, exist_ok=True)
        for f in files:
            src = Path(f)
            if src.is_dir():
                shutil.copytree(src, target / src.name, dirs_exist_ok=True)
            else:
                shutil.copy2(src, target / src.name)
        _run7z(["a", "-sccUTF-8", path, folder.split("/")[0]], cwd=str(stage))
    else:
        _run7z(["a", "-sccUTF-8", path, *files])


def delete_entries(path: str, entries: list[str]) -> None:
    _run7z(["d", "-sccUTF-8", path, *[e.replace("/", "\\") for e in entries]])


def rename_entry(path: str, old: str, new: str) -> None:
    _run7z(["rn", "-sccUTF-8", path, old.replace("/", "\\"), new.replace("/", "\\")])
