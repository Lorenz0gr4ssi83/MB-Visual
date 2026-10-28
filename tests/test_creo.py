"""Collaudo del lettore Creo / Pro/ENGINEER (mbvisual/fx_creo.py) su file veri.

    python tests/test_creo.py [cartella con file .prt/.asm/.drw/.frm]

Senza cartella scarica in una cartella temporanea quattro esempi pubblici del progetto creo2urdf (BSD-3-Clause, salvati con
Creo 9.0). Controlla: riconoscimento dal contenuto, tipo, nome, versione, sezioni, anteprima incorporata, esportazioni,
STEP esportato accanto al modello, estensione dei nomi con il numero di versione (pezzo.prt.3).
"""
import json
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from mbvisual import fx_creo, misc  # noqa: E402

ok = bad = 0


def check(name, cond, extra=""):
    global ok, bad
    ok += bool(cond)
    bad += not cond
    print(("OK   " if cond else "NO   ") + name + (f"  ({extra})" if extra and not cond else ""))


def main():
    if len(sys.argv) > 1:
        files = sorted(p for p in Path(sys.argv[1]).rglob("*") if p.is_file() and fx_creo.is_creo(p.read_bytes()[:8]))
    else:
        d = Path(tempfile.mkdtemp(prefix="mbv-creo-"))
        base = "https://raw.githubusercontent.com/mesh-iit/creo2urdf/master/examples/2bars/"
        files = []
        for n in ("bar.prt.1", "bar_2.prt.1", "2bars_pin.asm.1", "joints_assembled.asm.1"):
            p = d / n
            p.write_bytes(urllib.request.urlopen(base + n, timeout=60).read())
            files.append(p)
    check("file Creo trovati", files, "nessun file")
    for f in files:
        r = fx_creo.read(str(f))
        check(f"{f.name}: riconosciuto dal contenuto", misc.sniff(str(f))["kind"] == "creo")
        check(f"{f.name}: tipo {r['tipo']}", r["tipo"] in fx_creo.TIPI)
        check(f"{f.name}: versione {r['programma']} {r['versione']} {r['build']}", r["programma"] in ("Creo", "Pro/ENGINEER") and r["versione"])
        check(f"{f.name}: {len(r['sezioni'])} sezioni", len(r["sezioni"]) >= 5)
        if r["anteprima"]:
            png, hdr = fx_creo.preview(str(f))
            check(f"{f.name}: anteprima PNG", png.startswith(b"\x89PNG") and hdr["Content-Type"] == "image/png")
        out = Path(tempfile.mkdtemp(prefix="mbv-creo-out-"))
        for ext in ("txt", "json") + (("png",) if r["anteprima"] else ()):
            fx_creo.export(str(f), str(out / f"x.{ext}"))
            check(f"{f.name}: esportazione .{ext}", (out / f"x.{ext}").stat().st_size > 20)
        json.loads((out / "x.json").read_text(encoding="utf-8"))
        shutil.rmtree(out, ignore_errors=True)
    # STEP esportato accanto (pezzo.prt.3 -> pezzo.stp) e nome del modello
    d = Path(tempfile.mkdtemp(prefix="mbv-creo-step-"))
    src = files[0]
    shutil.copyfile(src, d / "staffa.prt.3")
    (d / "staffa.stp").write_text("ISO-10303-21;\nEND-ISO-10303-21;\n", encoding="ascii")
    (d / "altro.stp").write_text("ISO-10303-21;\nEND-ISO-10303-21;\n", encoding="ascii")
    r = fx_creo.read(str(d / "staffa.prt.3"))
    check("STEP accanto trovato (solo quello con lo stesso nome)", [Path(x).name for x in r["step"]] == ["staffa.stp"], r["step"])
    shutil.rmtree(d, ignore_errors=True)
    # nomi con il numero di versione: stessa regola di app.js (CREO_VERSIONED)
    import re
    rx = re.compile(r"\.(prt|asm|drw|frm)\.\d+$")
    check("estensione dai nomi con versione", [m.group(1) for m in map(rx.search, ["a.prt.1", "B.ASM.12".lower(), "c.drw.3"])] == ["prt", "asm", "drw"])
    print(f"\n{ok} riuscite, {bad} non riuscite")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
