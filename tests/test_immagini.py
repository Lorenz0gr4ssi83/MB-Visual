"""Collaudo del miglioramento foto (Real-ESRGAN) e della creazione di immagini (stable-diffusion.cpp): mbvisual/immagini.py.

Uso:  python tests/test_immagini.py            controllo scheda video, riga di comando (codici 0/1/3), API del server
      python tests/test_immagini.py --vero     anche un miglioramento e una generazione veri (lenti sui PC senza scheda idonea)
Prima: python tools/fetch_image_engines.py (motori in bin/).
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OK = 0
FAIL = []


def check(cond, name, info=""):
    global OK
    if cond:
        OK += 1
        print("  ok  ", name)
    else:
        FAIL.append(name)
        print("  NO  ", name, info)


def cli(*args, timeout=3600):
    t0 = time.time()
    r = subprocess.run([sys.executable, str(ROOT / "app.py"), *args], capture_output=True, timeout=timeout, cwd=str(ROOT))
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace"), time.time() - t0


def main():
    vero = "--vero" in sys.argv
    tmp = Path(tempfile.mkdtemp(prefix="mbv-immagini-"))
    from PIL import Image, ImageDraw
    src = tmp / "foto piccola.jpg"
    im = Image.new("RGB", (96, 64), (200, 220, 240))
    d = ImageDraw.Draw(im)
    d.ellipse((10, 10, 50, 50), fill=(220, 60, 40))
    d.text((55, 25), "MB", fill=(0, 0, 0))
    im.save(src, quality=60)

    print("scheda video")
    code, out, err, _ = cli("--scheda-video", timeout=120)
    sv = json.loads(out.strip().splitlines()[-1]) if code == 0 and out.strip() else {}
    check(code == 0, "--scheda-video esce con 0", err)
    check(set(sv) == {"idonea_migliora", "idonea_genera", "nome", "memoria_gb", "motivo"}, "JSON con le 5 chiavi", out)
    check(isinstance(sv.get("idonea_genera"), bool) and isinstance(sv.get("memoria_gb"), (int, float)), "tipi del JSON")
    print("   ", sv)

    print("riga di comando: errori")
    code, _, err, _ = cli("--migliora", str(src))
    check(code == 1 and err.strip(), "argomenti mancanti = codice 1 con messaggio", err)
    code, _, err, _ = cli("--migliora", str(src), str(tmp / "x.png"), "5", "--anche-lenta")
    check(code == 1 and "2, 3" in err, "scala non valida = codice 1", err)
    if not sv.get("idonea_genera"):
        code, _, err, _ = cli("--genera", "a red apple", str(tmp / "g.png"))
        check(code == 3 and ("idonea" in err or "suitable" in err), "scheda non idonea senza --anche-lenta = codice 3 + frase", f"{code} {err}")
        check(not (tmp / "g.png").exists(), "nessun file scritto con codice 3")
    if not sv.get("idonea_migliora"):
        code, _, err, _ = cli("--migliora", str(src), str(tmp / "m.png"))
        check(code == 3, "migliora: scheda non idonea = codice 3", err)

    print("API del server")
    from mbvisual import server
    httpd, port = server.start_server() if hasattr(server, "start_server") else (None, None)
    if isinstance(httpd, tuple):
        httpd, port = httpd
    base = f"http://127.0.0.1:{port}/api/"
    tok = server.TOKEN

    def call(route, params="", body=None, ctype="application/json"):
        req = urllib.request.Request(base + route + f"?t={tok}" + params, data=body, headers={"Content-Type": ctype} if body is not None else {})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    st, j = call("immagini/scheda-video")
    check(st == 200 and j.get("ok") and "idonea_genera" in j and "modelli" in j, "GET immagini/scheda-video", j)
    if not sv.get("idonea_genera"):
        st, j = call("immagini/genera", body=json.dumps({"descrizione": "a cat"}).encode())
        check(st == 409 and j.get("non_idonea"), "POST immagini/genera senza anche_lenta = 409 non_idonea", (st, j))
    st, j = call("immagini/annulla", "&rid=inesistente")
    check(st == 200 and j.get("trovato") is False, "annulla di un lavoro inesistente")

    def wait(jid, limit=7200):
        t0 = time.time()
        while time.time() - t0 < limit:
            _, r = call("job", f"&id={jid}")
            if r.get("status") in ("done", "error"):
                return r
            time.sleep(1)
        return {"status": "timeout"}

    if vero:
        print("miglioramento vero (Real-ESRGAN)")
        for s in (2, 3, 4):
            o = tmp / f"migliorata x{s}.png"
            code, out, err, sec = cli("--migliora", str(src), str(o), str(s), "--anche-lenta")
            ok = code == 0 and o.exists() and Image.open(o).size == (96 * s, 64 * s)
            check(ok, f"--migliora x{s} -> {96 * s}x{64 * s} in {sec:.1f} s", err[-500:])
        body = (tmp / "migliorata x2.png").read_bytes()
        st, j = call("immagini/migliora", "&scala=2&modello=disegno&anche_lenta=1", body, "image/png")
        r = wait(j.get("job")) if st == 200 else {}
        check(r.get("status") == "done" and Image.open(r["result"]["out"]).size == (384, 256), "API immagini/migliora (PNG nel corpo, disegno)", r)
        foto = os.environ.get("MBV_FOTO_PROVA")
        if foto:
            o = tmp / "foto vera x4.png"
            code, out, err, sec = cli("--migliora", foto, str(o), "4", "--anche-lenta")
            check(code == 0 and o.exists(), f"foto vera x4 in {sec:.1f} s", err[-500:])
            print("    ", out.strip())

        print("generazione vera (stable-diffusion.cpp)")
        o = tmp / "generata.png"
        code, out, err, sec = cli("--genera", "a photo of a red apple on a wooden table", str(o), "512", "512", "--anche-lenta", "--seme", "42")
        ok = code == 0 and o.exists() and Image.open(o).size == (512, 512)
        check(ok, f"--genera 512x512 in {sec:.1f} s", err[-800:])
        if ok:
            print("    ", out.strip())
            px = Image.open(o).convert("RGB").resize((8, 8)).getcolors(64) or []
            check(len(px) > 4, "l'immagine generata non e' a tinta unita")
        st, j = call("immagini/genera", body=json.dumps({"descrizione": "a blue sports car", "larghezza": 384, "altezza": 256, "anche_lenta": True, "seme": 7}).encode())
        r = wait(j.get("job")) if st == 200 else {}
        check(r.get("status") == "done" and Image.open(r["result"]["out"]).size == (384, 256), "API immagini/genera 384x256", r)
        st, j = call("immagini/genera", body=json.dumps({"descrizione": "a house", "anche_lenta": True}).encode())
        time.sleep(4)
        call("immagini/annulla", f"&rid={j.get('rid')}")
        r = wait(j.get("job"), 300)
        check(r.get("status") == "error", "annulla ferma la generazione", r)
    print(f"\n{OK} prove riuscite, {len(FAIL)} fallite" + (": " + ", ".join(FAIL) if FAIL else ""))
    print("cartella delle prove:", tmp)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
