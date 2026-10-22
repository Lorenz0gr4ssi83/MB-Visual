"""Prova dell'app su macOS (runner GitHub macos-14, vedi .github/workflows/build-mac.yml).

1. Funzioni Python legate al sistema: impronta della licenza, caratteri, stampanti CUPS, OCR con Vision (bin/mbvocr),
   conversioni (immagini, PDF).
2. Interfaccia in WebKit (lo stesso motore della finestra pywebview sul Mac) con Playwright: l'app gira da sorgente
   (`python app.py --browser`), si aprono i file di esempio con MB.openFile e per ognuno si controlla che il visualizzatore
   non mostri errori; una schermata per file.

Uso:  python tests/mac_smoke.py CARTELLA_USCITA
Uscita: CARTELLA_USCITA/esito.json, esito.md (riassunto), schermate/*.png. Codice di uscita 1 se qualcosa non va.
"""
import json
import os
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "tests" / "samples"
sys.path.insert(0, str(ROOT))

FILES = ["confronto/relazione_revA.pdf", "pianta.dxf", "confronto/capannone_revA.ifc", "relazione.docx", "computo.xlsx",
         "presentazione.pptx", "immagine.png", "immagine.tif", "scansione_foglio1.jpg", "video_prova.mp4", "tono.wav",
         "dati.csv", "note.md", "messaggio.eml", "disegno.svg", "cubo.obj", "cubo.stl", "contratto_firmato.pdf.p7m",
         "archivio_commesse.sqlite", "pagina.html"]


RESULTS: list = []
OUT = Path(".")


def step(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def check(results, name, fn):
    t0 = time.time()
    try:
        info = fn()
        results.append({"prova": name, "ok": True, "info": info, "s": round(time.time() - t0, 1)})
    except Exception as e:  # noqa: BLE001
        results.append({"prova": name, "ok": False, "errore": f"{type(e).__name__}: {e}", "dettaglio": traceback.format_exc()[-1500:],
                        "s": round(time.time() - t0, 1)})
    r = results[-1]
    print(("OK   " if r["ok"] else "ERR  ") + name, r.get("info") or r.get("errore"), flush=True)


def python_checks(out: Path) -> list:
    res = []
    from mbvisual import convert, fonts, license, paths, pdfedit, stampa
    check(res, "sistema", lambda: {"mac": paths.IS_MAC, "dati": str(paths.DATA_DIR), "strumenti": paths.tools_status()})
    check(res, "impronta licenza (IOPlatformUUID)", lambda: license.device_id()[:8] if license._machine_guid() else None)
    check(res, "caratteri di sistema", lambda: {"famiglie": len(fonts.index()), "arial": fonts.find("arial"),
                                                "pdf_calibri": str(pdfedit._font_file("Calibri", False, False))})
    check(res, "stampanti CUPS", lambda: [p["label"] for p in stampa.printers()["printers"]])
    work = out / "file"
    work.mkdir(parents=True, exist_ok=True)

    def conv(src, ext):
        dst = work / (Path(src).stem + "." + ext)
        r = convert.convert(str(SAMPLES / src), str(dst))
        made = [Path(f) for f in (r.get("files") or [r.get("path") or dst])]
        size = sum(f.stat().st_size for f in made if f.is_file())
        assert size > 0, "file vuoto"
        return f"{len(made)} file, {size} byte"
    check(res, "converti PNG -> JPG", lambda: conv("immagine.png", "jpg"))
    check(res, "converti PDF -> PNG", lambda: conv("confronto/relazione_revA.pdf", "png"))
    check(res, "converti WAV -> MP3 (FFmpeg)", lambda: conv("tono.wav", "mp3"))
    check(res, "converti MP4 -> MOV (FFmpeg)", lambda: conv("video_prova.mp4", "mov"))
    if paths.find_libreoffice():
        check(res, "converti DOCX -> PDF (LibreOffice)", lambda: conv("relazione.docx", "pdf"))
    else:
        res.append({"prova": "converti DOCX -> PDF", "ok": True, "info": "saltata: LibreOffice non installato (sul Mac serve per Office -> PDF)"})

    def ocr():
        import pymupdf
        pdf = work / "scansione.pdf"
        with pymupdf.open() as d:
            img = pymupdf.open(str(SAMPLES / "scansione_foglio1.jpg"))
            rect = img[0].rect
            page = d.new_page(width=rect.width, height=rect.height)
            page.insert_image(page.rect, filename=str(SAMPLES / "scansione_foglio1.jpg"))
            d.save(pdf)
        r = pdfedit.ocr(str(pdf), str(work / "scansione_ocr.pdf"))
        with pymupdf.open(str(work / "scansione_ocr.pdf")) as d:
            text = d[0].get_text().strip()
        assert text, "nessun testo riconosciuto"
        return {"esito": r, "testo": re.sub(r"\s+", " ", text)[:120]}
    check(res, "OCR con Vision (Rendi ricercabile)", ocr)
    return res


def ui_checks(out: Path, engine: str = "webkit") -> list:
    from playwright.sync_api import sync_playwright
    res = []
    shots = out / "schermate"
    shots.mkdir(parents=True, exist_ok=True)
    log = open(out / "app.log", "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, str(ROOT / "app.py"), "--browser", "--no-open"], cwd=str(ROOT), stdout=subprocess.PIPE,
                            stderr=log, text=True)
    url = ""
    t0 = time.time()
    while time.time() - t0 < 120 and not url:
        line = proc.stdout.readline()
        if line.startswith("http"):
            url = line.strip()
    if not url:
        proc.kill()
        return [{"prova": "avvio interfaccia", "ok": False, "errore": "il server non e' partito"}]
    step("server avviato: " + url.split("?")[0])
    try:
        with sync_playwright() as pw:
            step(f"avvio di {engine}")
            browser = getattr(pw, engine).launch(timeout=120000)
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.set_default_timeout(30000)
            page.on("dialog", lambda d: d.dismiss())
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            step("caricamento dell'interfaccia")
            page.goto(url, timeout=60000)
            page.wait_for_function("window.MB && typeof MB.openFile === 'function'", timeout=60000)
            page.wait_for_timeout(2000)
            page.screenshot(path=str(shots / f"{engine}_00_home.png"))
            res.append({"prova": f"interfaccia avviata ({engine})", "ok": not errors, "info": url.split("?")[0], "errori_console": errors[:10]})
            RESULTS.extend(res)
            res = RESULTS  # i risultati restano anche se il controllo del tempo chiude tutto
            for i, rel in enumerate(FILES, 1):
                p = SAMPLES / rel
                if not p.is_file():
                    continue
                errors.clear()
                t1 = time.time()
                step(f"apertura di {rel}")
                try:
                    page.evaluate("p => { MB.openFile(p); }", str(p))
                    page.wait_for_timeout(1500)
                    # attesa: errore mostrato oppure 12 s per i visualizzatori pesanti (ONLYOFFICE, IFC, video)
                    deadline = time.time() + (25 if p.suffix in (".docx", ".xlsx", ".pptx", ".ifc") else 10)
                    state = {}
                    while time.time() < deadline:
                        state = page.evaluate("""() => { const t = MB.active; if (!t) return {none: true};
                            const e = t.view.querySelector('.err');
                            return {viewer: t.viewer, err: e ? e.textContent : null, kids: t.view.querySelector('.body')?.childElementCount || 0}; }""")
                        if state.get("err"):
                            break
                        page.wait_for_timeout(1000)
                    page.screenshot(path=str(shots / f"{engine}_{i:02d}_{p.name}.png"))
                    ok = not state.get("err") and not state.get("none") and state.get("kids", 0) > 0
                    res.append({"prova": f"apri {rel}", "ok": ok, "info": {"visualizzatore": state.get("viewer"), "errore": state.get("err")},
                                "errori_console": [e for e in errors if "favicon" not in e][:5], "s": round(time.time() - t1, 1)})
                except Exception as e:  # noqa: BLE001
                    res.append({"prova": f"apri {rel}", "ok": False, "errore": str(e)[:300]})
                print(("OK   " if res[-1]["ok"] else "ERR  ") + res[-1]["prova"], res[-1].get("info") or res[-1].get("errore"), flush=True)
            browser.close()
    finally:
        proc.terminate()
    return res


def main() -> int:
    global OUT
    out = OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "mac-prove").resolve()
    out.mkdir(parents=True, exist_ok=True)
    import threading

    def timeout():  # WebKit o una pagina bloccata: si chiude scrivendo i risultati fin qui
        RESULTS.append({"prova": "tempo massimo (12 min)", "ok": False, "errore": "prova interrotta: ultima riga del registro = punto del blocco"})
        report(RESULTS)
        os._exit(1)
    if "--ui" in sys.argv:  # processo figlio: solo l'interfaccia con un motore, risultati in ui_<motore>.json
        engine = sys.argv[sys.argv.index("--ui") + 1]
        try:
            ui = ui_checks(out, engine)
        except Exception as e:  # noqa: BLE001
            ui = RESULTS + [{"prova": f"interfaccia ({engine})", "ok": False, "errore": f"{type(e).__name__}: {e}"}]
        (out / f"ui_{engine}.json").write_text(json.dumps(ui, ensure_ascii=False, default=str), encoding="utf-8")
        os._exit(0)
    threading.Timer(1500, timeout).start()
    RESULTS.extend(python_checks(out))
    # interfaccia: WebKit (motore della finestra Mac); sul runner macOS 14 il WebKit di Playwright puo' bloccarsi
    # all'avvio, allora si ripete con Chromium (stesso codice dell'interfaccia, motore diverso)
    for engine in ("webkit", "chromium"):
        f = out / f"ui_{engine}.json"
        try:
            subprocess.run([sys.executable, __file__, str(out), "--ui", engine], timeout=540)
        except subprocess.TimeoutExpired:
            step(f"{engine}: tempo scaduto")
        ui = json.loads(f.read_text(encoding="utf-8")) if f.is_file() else []
        if not ui:
            RESULTS.append({"prova": f"interfaccia ({engine})", "ok": False, "errore": f"{engine} non si avvia sul runner"})
            continue
        RESULTS.extend(ui)
        break
    ok = report(RESULTS)
    os._exit(0 if ok else 1)


def report(results) -> bool:
    out = OUT
    (out / "esito.json").write_text(json.dumps(results, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    lines = ["| Prova | Esito | Dettaglio |", "|---|---|---|"]
    for r in results:
        det = r.get("errore") or r.get("info") or ""
        det = re.sub(r"[\r\n|]+", " ", json.dumps(det, ensure_ascii=False, default=str) if not isinstance(det, str) else det)[:220]
        lines.append(f"| {r['prova']} | {'OK' if r['ok'] else 'ERRORE'} | {det} |")
    ok = sum(r["ok"] for r in results)
    md = f"### Prove su macOS: {ok} di {len(results)} riuscite\n\n" + "\n".join(lines) + "\n"
    (out / "esito.md").write_text(md, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md)
    print(md, flush=True)
    return ok == len(results)


if __name__ == "__main__":
    raise SystemExit(main())
