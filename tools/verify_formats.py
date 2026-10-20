"""Verifica che l'elenco dei formati (ui/formats.json) sia coerente con i motori inclusi nell'app.

Per ogni motore confronta le estensioni che dichiara di saper leggere con quelle presenti nel registro:
- "mancanti": il motore le legge ma non sono nell'elenco (candidate da aggiungere)
- "non coperte": sono nell'elenco della categoria ma il motore non le dichiara (da controllare)
Uso: python tools/verify_formats.py [monaco_exts.json]
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from mbvisual.paths import find_7zip, find_ffmpeg  # noqa: E402

reg = json.loads((ROOT / "ui" / "formats.json").read_text(encoding="utf-8"))
cats = {c["id"]: set(c["exts"]) for c in reg["categories"]}
listed = set().union(*cats.values())
NO_WINDOW = 0x08000000


def run(args):
    return subprocess.run(args, capture_output=True, creationflags=NO_WINDOW).stdout.decode("utf-8", "replace")


def pillow_exts():
    from PIL import Image
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass
    Image.init()
    readable = {f for f in Image.OPEN}
    return {e.lstrip(".").lower() for e, f in Image.registered_extensions().items() if f in readable}


def ffmpeg_exts():
    ff = find_ffmpeg()
    names = re.findall(r"^\s*D[ d]?\s+(\S+)", run([ff, "-hide_banner", "-demuxers"]), re.M)
    exts = {}
    for n in names:
        for nm in n.split(","):
            out = run([ff, "-hide_banner", "-h", f"demuxer={nm}"])
            m = re.search(r"Common extensions: ([^.\n]+)", out)
            if m:
                for e in m.group(1).split(","):
                    exts.setdefault(e.strip().lower(), nm)
    return exts


def sevenzip_exts():
    out = run([find_7zip(), "i"])
    exts = set()
    for line in out.splitlines():
        m = re.match(r"^\s*\d+\s+[A-Z ]{0,8}\s+(\S+)\s+(.+?)\s{2,}", line)
        if m:
            for tok in m.group(2).split():
                if re.fullmatch(r"[a-z0-9~.]+", tok) and not tok.startswith("("):
                    exts.add(tok.strip("~.").lower())
    return exts


def report(title, engine, category_ids, skip=()):
    covered = set().union(*(cats[c] for c in category_ids))
    missing = sorted(e for e in engine if e not in listed and e not in skip)
    not_engine = sorted(covered - engine)
    lines = [f"## {title}", "", f"Estensioni dichiarate dal motore: {len(engine)}", "",
             f"**Lette dal motore ma non in elenco ({len(missing)}):** " + (" ".join(f"`.{e}`" for e in missing) or "nessuna"), "",
             f"**In elenco ma non dichiarate dal motore ({len(not_engine)}):** " + (" ".join(f"`.{e}`" for e in not_engine) or "nessuna"), ""]
    return lines, missing


def main():
    out = ["# Verifica dei formati", ""]
    l, _ = report("Immagini (Pillow + HEIF)", pillow_exts(), ["image"])
    out += l
    ff = ffmpeg_exts()
    l, _ = report("Audio e video (FFmpeg)", set(ff), ["media", "audio"])
    out += l
    l, _ = report("Archivi (7-Zip)", sevenzip_exts(), ["archive"])
    out += l
    if len(sys.argv) > 1:
        mon = set(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
        l, _ = report("Testo e codice (Monaco)", mon, ["text", "markdown", "html"])
        out += l
    (ROOT / "tests" / "verifica_formati.md").write_text("\n".join(out), encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
