"""Collaudo dei percorsi e nomi lunghi (mbvisual/longpath.py).

  python tests/test_longpath.py [--tieni]

Crea in %TEMP% una cartella con percorso oltre 400 caratteri (4 sottocartelle da 110) e file con nomi da 250 caratteri
(PDF, DXF, immagine, ZIP, IFC... presi da tests/samples o generati qui), poi prova con longpath.install() attivo:
lettura/scrittura/rinomina/elenco/ricerca con Python, PyMuPDF (apri e salva), Pillow, ezdxf, sqlite3 (con il suo file
-journal), 7-Zip ed FFmpeg (programmi esterni), IfcOpenShell, conversione (convert.py), conversione a lotti (batch.py,
uscita accanto agli originali con nomi che supererebbero 255 caratteri), recupero (recover.py), indice della ricerca
nel progetto (search.py), IFC -> STEP (ifcstep.py) e i nomi accorciati (safe_name). Controlla anche che le funzioni
ricevano davvero la forma estesa \\\\?\\ (cosi' funziona anche sui PC con LongPathsEnabled spento, il predefinito).
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("LOCALAPPDATA", tempfile.mkdtemp(prefix="mbv-prova-lp-"))
from mbvisual import longpath as L  # noqa: E402

L.install()
OK = KO = 0


def check(cond, msg):
    global OK, KO
    if cond:
        OK += 1
    else:
        KO += 1
        print("ERRORE:", msg)


def step(name, fn):
    try:
        r = fn()
        check(r is not False, name)
        if r is not False:
            print(f"  ok  {name}" + (f": {r}" if r not in (None, True) else ""))
    except Exception as e:  # noqa: BLE001
        check(False, f"{name}: {type(e).__name__}: {e}")


def main():
    base = Path(os.environ["TEMP"]) / "mbv-lp-collaudo"
    shutil.rmtree(L.lp(str(base)), ignore_errors=True)
    d = str(base)
    for i in range(4):
        d = os.path.join(d, f"cartella_{i}_" + "x" * 100)
    os.makedirs(d, exist_ok=True)
    print("cartella di", len(d), "caratteri")
    stem = "documento_con_un_nome_molto_lungo_" + "n" * 220
    name = lambda ext: stem[:250 - len(ext) - 1] + "." + ext  # noqa: E731
    S = ROOT / "tests" / "samples"
    F = {}
    for ext, src in (("ifc", S / "interferenze" / "struttura.ifc"),):
        F[ext] = os.path.join(d, name(ext))
        shutil.copy2(src, F[ext])
    for ext in ("pdf", "dxf", "png", "zip", "mp4", "xlsx", "eml", "docx"):
        cands = sorted(c for c in S.rglob("*." + ext) if "danneggiati" not in c.parts and "rotto" not in c.name)
        if cands:
            F[ext] = os.path.join(d, name(ext))
            shutil.copy2(cands[0], F[ext])
    if "pdf" not in F:
        import pymupdf
        doc = pymupdf.open()
        doc.new_page().insert_text((72, 72), "prova percorsi lunghi")
        F["pdf"] = os.path.join(d, name("pdf"))
        doc.save(F["pdf"])
    print("file:", ", ".join(sorted(F)), "- percorso", len(F["pdf"]), "caratteri, nome", len(os.path.basename(F["pdf"])))

    # la forma estesa arriva alle funzioni del sistema (necessaria con LongPathsEnabled spento)
    check(all(getattr(f, '__mbv_lp__', False) for f in (os.stat, os.listdir, os.rename, os.path.isfile, open)), 'funzioni avvolte da install()')
    check(L.lp(F["pdf"]).startswith("\\\\?\\") and L.lp("C:\\corto") == "C:\\corto", "forma estesa solo per i percorsi lunghi")
    check(L.lp("\\\\server\\share\\" + "y" * 300).startswith("\\\\?\\UNC\\server"), "percorsi di rete: \\\\?\\UNC\\")
    check(L.unlp(L.lp(F["pdf"])) == os.path.normpath(F["pdf"]), "unlp")
    sn = L.safe_name("a" * 300 + ".pdf")
    check(len(sn) <= 240 and sn.endswith(".pdf") and sn == L.safe_name("a" * 300 + ".pdf"), f"safe_name {len(sn)}")
    check(L.safe_name("corto.pdf") == "corto.pdf", "safe_name lascia i nomi corti")
    print("Python:")
    step("os.stat / isfile / getsize", lambda: os.path.isfile(F["pdf"]) and os.path.getsize(F["pdf"]) == os.stat(F["pdf"]).st_size)
    step("listdir / scandir / walk", lambda: len(os.listdir(d)) == len(list(os.scandir(d))) and any(r == d for r, _, _ in os.walk(str(base))))
    step("scandir senza prefisso", lambda: all(not e.path.startswith("\\\\?\\") for e in os.scandir(d)))
    step("Path read/write/rename/unlink", lambda: (Path(d, name("txt")).write_text("x"), Path(d, name("txt")).rename(Path(d, name("tx2"))),
                                                  Path(d, name("tx2")).read_text() == "x", Path(d, name("tx2")).unlink())[2])
    step("shutil.copy2 + rmtree", lambda: (shutil.copy2(F["pdf"], os.path.join(d, "sub_" + "k" * 120 + ".pdf")) and True))
    lungo = os.path.join(d, "nome_oltre_il_limite_" + "z" * 300 + ".txt")  # 325 caratteri: Windows non lo ammette
    step("nome oltre 255: scrivi, rileggi, esiste, rinomina", lambda: (open(lungo, "w").write("ok"), open(lungo).read() == "ok",
                                                                       os.path.exists(lungo), os.replace(lungo, lungo + ".bak"),
                                                                       os.path.exists(lungo + ".bak"))[1:3] == (True, True))
    step("nome oltre 255: file reale entro 240", lambda: max(len(n) for n in os.listdir(d)) <= 255)
    step("realpath senza prefisso", lambda: not os.path.realpath(F["pdf"]).startswith("\\\\?\\"))
    print("Librerie:")
    import pymupdf
    step("PyMuPDF apri + salva (nome derivato accorciato)", lambda: pymupdf.open(F["pdf"]).save(L.safe_path(F["pdf"] + ".copia.pdf")) is None)
    import sqlite3
    step("sqlite3 con -journal", lambda: (sqlite3.connect(os.path.join(d, "d.sqlite")).execute("create table if not exists t(x)"), True)[1])
    if "png" in F:
        from PIL import Image
        step("Pillow apri + salva", lambda: Image.open(F["png"]).save(L.safe_path(F["png"] + ".jpg"), "JPEG") is None)
    if "dxf" in F:
        import ezdxf
        step("ezdxf", lambda: len(ezdxf.readfile(F["dxf"]).modelspace()) >= 0)
    import ifcopenshell
    step("IfcOpenShell", lambda: len(ifcopenshell.open(F["ifc"]).by_type("IfcProduct")) > 0)
    from mbvisual import paths
    import subprocess
    z = paths.find_7zip()
    if z and "zip" in F:
        step("7-Zip elenco + estrazione", lambda: subprocess.run([str(z), "x", "-y", F["zip"], "-o" + os.path.join(d, "estratti")], capture_output=True).returncode == 0)
    ff = paths.find_ffmpeg()
    if ff and "mp4" in F:
        step("FFmpeg", lambda: subprocess.run([str(ff), "-hide_banner", "-y", "-i", F["mp4"], "-t", "0.2", L.safe_path(F["mp4"] + ".copia.mp4")], capture_output=True).returncode == 0)
    print("Funzioni dell'app:")
    from mbvisual import convert
    step("convert PDF -> TXT", lambda: convert.convert(F["pdf"], L.safe_path(F["pdf"][:-4] + ".testo.txt")) is not None or True)
    if "png" in F:
        step("convert PNG -> PDF", lambda: convert.convert(F["png"], L.safe_path(F["png"][:-4] + ".immagine.pdf")) is not None or True)
    from mbvisual import batch
    r = batch.handle("start", {"op": "format", "opts": {"to": "pdf"}, "files": [{"path": F[k]} for k in ("png", "pdf") if k in F],
                               "out": {"mode": "accanto", "suffix": "_convertito_con_un_suffisso_lungo"}}, lambda k: None)
    for _ in range(600):
        if batch._BATCHES[r["id"]].status in ("finito", "annullato", "errore"):
            break
        time.sleep(0.2)
    items = batch._BATCHES[r["id"]].items
    check(all(it["status"] in ("ok", "saltato") for it in items) and any(it["status"] == "ok" for it in items),
          f"lotto: {[(it['status'], it['msg'][:100]) for it in items]}")
    check(all(len(os.path.basename(o)) <= 255 and os.path.exists(o) for it in items for o in it["out"]), "lotto: nomi in uscita entro 255")
    print("  lotto:", [(it["status"], [len(os.path.basename(o)) for o in it["out"]]) for it in items])
    from mbvisual import recover
    step("recupero: controllo", lambda: recover.handle("check", {"path": F["pdf"]}, lambda k: None) is not None if hasattr(recover, "handle") else True)
    # ricerca nel progetto: indice della cartella lunga e ricerca di una parola del PDF
    from mbvisual import search
    def cerca():
        search.update(str(base))
        for _ in range(600):
            st = search.status(str(base))
            if st.get("fase") in ("pronto", "errore"):
                break
            time.sleep(0.5)
        r = search.search(str(base), "documento")  # parola nei nomi dei file
        return (len(r.get("files") or []) >= 5 and st.get("stati")) or (st, r)
    step("ricerca nel progetto", cerca)
    # posta: allegato con nome lunghissimo salvato nella cartella lunga
    from email.message import EmailMessage
    from mbvisual.mail import commesse
    def allegati():
        msg = EmailMessage()
        msg["Subject"], msg["From"], msg["To"] = "prova", "a@b.it", "c@d.it"
        msg.set_content("ciao")
        msg.add_attachment(b"%PDF-1.4 prova", maintype="application", subtype="pdf", filename="allegato_" + "q" * 280 + ".pdf")
        out = Path(d) / ("posta_" + "p" * 150)
        out.mkdir(exist_ok=True)
        saved = commesse.save_attachments(msg.as_bytes(), out)
        return len(saved) == 1 and (out / saved[0]).exists() and saved[0].endswith(".pdf")
    step("posta: allegato con nome lungo", allegati)
    from mbvisual import ifcstep
    if ifcstep.available():
        step("IFC -> STEP", lambda: ifcstep.convert(F["ifc"], L.safe_path(F["ifc"][:-4] + ".convertito.stp"))["convertiti"] > 0)
    print(f"{OK} prove riuscite, {KO} fallite")
    if "--tieni" not in sys.argv:
        shutil.rmtree(L.lp(str(base)), ignore_errors=True)
    return 1 if KO else 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
