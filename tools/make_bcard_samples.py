"""Biglietti da visita sintetici per le prove dello scanner dell'app per telefono (ui/js/bcard.js).

    python tools/make_bcard_samples.py [cartella]      (predefinita: tests/samples/biglietti)

Per ogni biglietto: fronte e retro a 85 x 55 mm (600 dpi, PNG) e una "foto" JPEG del biglietto appoggiato su un piano
(prospettiva, rotazione, ombra, luce non uniforme) da usare con la fotocamera simulata. attesi.json = testo di ogni lato,
contenuto del QR e campi attesi (letti da tests/test_bcard.mjs). Persone, aziende e numeri sono inventati.
I QR si disegnano con ui/vendor/qrcode-generator (MIT) tramite Node.
"""
import json
import math
import random
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests" / "samples" / "biglietti"
DPI = 600
W, H = round(85 / 25.4 * DPI), round(55 / 25.4 * DPI)
FONTS = Path("C:/Windows/Fonts")


def font(name, pt):
    for n in (name, "arial.ttf"):
        try:
            return ImageFont.truetype(str(FONTS / n), round(pt / 72 * DPI))
        except OSError:
            continue
    return ImageFont.load_default()


def qr_matrix(text):
    js = ("import { qrcode } from './ui/vendor/qrcode-generator/dist/qrcode.mjs';"
          "qrcode.stringToBytes = s => [...new TextEncoder().encode(s)];"
          "const q = qrcode(0, 'M'); q.addData(process.argv[1], 'Byte'); q.make();"
          "const n = q.getModuleCount(); const m = [];"
          "for (let r = 0; r < n; r++) { let s = ''; for (let c = 0; c < n; c++) s += q.isDark(r, c) ? '1' : '0'; m.push(s); }"
          "console.log(JSON.stringify(m));")
    out = subprocess.run(["node", "--input-type=module", "-e", js, text], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def draw_qr(img, text, x, y, size):
    m = qr_matrix(text)
    n = len(m) + 8  # zona di rispetto di 4 moduli
    k = size / n
    d = ImageDraw.Draw(img)
    d.rectangle([x, y, x + size, y + size], fill="white")
    for r, row in enumerate(m):
        for c, v in enumerate(row):
            if v == "1":
                d.rectangle([x + (c + 4) * k, y + (r + 4) * k, x + (c + 5) * k - 1, y + (r + 5) * k - 1], fill="black")


def card(bg="white"):
    return Image.new("RGB", (W, H), bg)


def text_lines(img, items, x, y, color="#1b1d1f"):
    """items: (testo, font, colore|None, spazio dopo in pt)"""
    d = ImageDraw.Draw(img)
    for t, f, col, gap in items:
        d.text((x, y), t, font=f, fill=col or color)
        y += f.size * 1.18 + gap / 72 * DPI
    return y


def photo(front, seed, table=(52, 40, 30)):
    """il biglietto fotografato su un piano: prospettiva, rotazione, ombra, luce non uniforme"""
    rnd = random.Random(seed)
    PW, PH = 2400, 1800
    base = Image.new("RGB", (PW, PH), table)
    # venature del piano
    d = ImageDraw.Draw(base)
    for i in range(0, PH, 7):
        v = rnd.randint(-10, 10)
        d.line([(0, i), (PW, i + rnd.randint(-30, 30))], fill=tuple(max(0, min(255, c + v)) for c in table), width=5)
    base = base.filter(ImageFilter.GaussianBlur(2))
    cw = 1500
    ch = cw * H / W
    cx, cy = PW / 2 + rnd.randint(-120, 120), PH / 2 + rnd.randint(-80, 80)
    ang = math.radians(rnd.uniform(-9, 9))
    pts = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        px, py = sx * cw / 2, sy * ch / 2
        persp = 1 + 0.07 * sy  # lato in basso piu' largo (fotocamera inclinata)
        px *= persp
        pts.append((cx + px * math.cos(ang) - py * math.sin(ang), cy + px * math.sin(ang) + py * math.cos(ang)))
    # ombra
    sh = Image.new("L", (PW, PH), 0)
    ImageDraw.Draw(sh).polygon([(x + 18, y + 26) for x, y in pts], fill=150)
    sh = sh.filter(ImageFilter.GaussianBlur(22))
    base.paste(Image.new("RGB", (PW, PH), (10, 8, 6)), (0, 0), sh)
    # trasformazione prospettica: coefficienti che portano i punti della foto ai punti del biglietto
    coeffs = perspective_coeffs([(0, 0), (W, 0), (W, H), (0, H)], pts)
    warped = front.transform((PW, PH), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    mask = Image.new("L", (PW, PH), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    base.paste(warped, (0, 0), mask)
    # luce: piu' chiaro in alto a sinistra
    grad = Image.linear_gradient("L").rotate(-35, expand=False).resize((PW, PH))
    base = Image.composite(base, Image.eval(base, lambda v: int(v * 0.82)), grad.point(lambda v: 255 - v // 2))
    return base.filter(ImageFilter.GaussianBlur(0.8))


def perspective_coeffs(src, dst):
    # omografia: punto della foto (dst) -> punto del biglietto (src), come vuole Image.transform
    import numpy as np
    A, B = [], []
    for (x, y), (u, v) in zip(src, dst):
        A.append([u, v, 1, 0, 0, 0, -x * u, -x * v]); B.append(x)
        A.append([0, 0, 0, u, v, 1, -y * u, -y * v]); B.append(y)
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()


# piano chiaro sotto i biglietti scuri (su un piano scuro neanche l'occhio vede il bordo)
TABLES = {"bilingue_fronte": (196, 190, 178)}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    B, R, I = "arialbd.ttf", "arial.ttf", "georgiai.ttf"
    cards = []

    # 1) biglietto italiano con fronte e retro
    f = card()
    d = ImageDraw.Draw(f)
    d.rectangle([0, 0, W, 120], fill="#e8711f")
    text_lines(f, [("Ing. Marco Bellini", font(B, 13), None, 2), ("Direttore tecnico", font(R, 9), "#555", 0)], 130, 420)
    text_lines(f, [("Bellini Progetti S.r.l.", font(B, 10), "#e8711f", 0)], 130, 1050)
    r = card("#f4f2ee")
    text_lines(r, [
        ("Via Giuseppe Mazzini, 48", font(R, 8), None, 0), ("40121 Bologna (BO)", font(R, 8), None, 4),
        ("Tel. +39 051 234 5678", font(R, 8), None, 0), ("Cell. 348 765 4321", font(R, 8), None, 0),
        ("m.bellini@belliniprogetti.it", font(R, 8), None, 0), ("www.belliniprogetti.it", font(R, 8), None, 4),
        ("P.IVA 03456789012", font(R, 6.5), "#666", 0)], 130, 150)
    cards.append(("it_fronte_retro", [("fronte", f, ["Ing. Marco Bellini", "Direttore tecnico", "Bellini Progetti S.r.l."]),
                                      ("retro", r, ["Via Giuseppe Mazzini, 48", "40121 Bologna (BO)", "Tel. +39 051 234 5678", "Cell. 348 765 4321",
                                                    "m.bellini@belliniprogetti.it", "www.belliniprogetti.it", "P.IVA 03456789012"])], None,
                  {"given": "Marco", "family": "Bellini", "org": "Bellini Progetti S.r.l.", "title": "Direttore tecnico",
                   "emails": ["m.bellini@belliniprogetti.it"], "phones": ["work 0512345678", "cell 3487654321"], "city": "Bologna"}))

    # 2) solo fronte con QR vCard (il QR vince: secondo nome e numero diretto ci sono solo li')
    vc = ("BEGIN:VCARD\nVERSION:3.0\nN:Ferraris;Chiara Maria;;Arch.;\nFN:Arch. Chiara Maria Ferraris\nORG:Studio Ferraris Architetti\n"
          "TITLE:Architetto\nTEL;TYPE=CELL:+39 339 112 2334\nTEL;TYPE=WORK:+39 011 445 5667\nEMAIL:chiara@studioferraris.it\n"
          "URL:https://studioferraris.it\nADR;TYPE=WORK:;;Corso Francia 120;Torino;TO;10143;Italia\nEND:VCARD")
    f = card()
    text_lines(f, [("Arch. Chiara Ferraris", font(B, 12), None, 2), ("Architetto", font(I, 9), "#555", 6),
                   ("Studio Ferraris Architetti", font(R, 8), None, 0), ("Corso Francia 120 - 10143 Torino", font(R, 7.5), None, 0),
                   ("Tel. 011 445 5667", font(R, 7.5), None, 0), ("chiara@studioferraris.it", font(R, 7.5), None, 0)], 110, 160)
    draw_qr(f, vc, W - 640, H - 640, 560)
    cards.append(("qr_vcard", [("fronte", f, ["Arch. Chiara Ferraris", "Architetto", "Studio Ferraris Architetti", "Corso Francia 120 - 10143 Torino",
                                             "Tel. 011 445 5667", "chiara@studioferraris.it"])], vc,
                  {"given": "Chiara Maria", "family": "Ferraris", "org": "Studio Ferraris Architetti", "title": "Architetto",
                   "emails": ["chiara@studioferraris.it"], "phones": ["cell 3391122334", "work 0114455667"], "city": "Torino"}))

    # 3) bilingue: fronte in italiano, retro in inglese, stessi recapiti (nessun doppione)
    f = card("#1d2a36")
    text_lines(f, [("Elena Moretti", font(B, 13), "#ffffff", 2), ("Responsabile commerciale", font(R, 8.5), "#c9d3dc", 8),
                   ("Moretti Impianti S.p.A.", font(B, 9), "#f0a35e", 0), ("Cell. +39 335 246 8100", font(R, 8), "#ffffff", 0),
                   ("e.moretti@morettimpianti.com", font(R, 8), "#ffffff", 0)], 120, 220)
    r = card("#ffffff")
    text_lines(r, [("Elena Moretti", font(B, 12), None, 2), ("Sales Manager", font(R, 8.5), "#555", 8),
                   ("Moretti Impianti S.p.A.", font(B, 9), None, 0), ("Via dell'Industria 7, 25125 Brescia BS, Italy", font(R, 7.5), None, 0),
                   ("Mobile +39 335 246 8100", font(R, 7.5), None, 0), ("Office +39 030 998 7766", font(R, 7.5), None, 0),
                   ("e.moretti@morettimpianti.com", font(R, 7.5), None, 0), ("linkedin.com/in/elenamoretti", font(R, 7.5), None, 0)], 120, 140)
    cards.append(("bilingue", [("fronte", f, ["Elena Moretti", "Responsabile commerciale", "Moretti Impianti S.p.A.", "Cell. +39 335 246 8100",
                                              "e.moretti@morettimpianti.com"]),
                               ("retro", r, ["Elena Moretti", "Sales Manager", "Moretti Impianti S.p.A.", "Via dell'Industria 7, 25125 Brescia BS, Italy",
                                             "Mobile +39 335 246 8100", "Office +39 030 998 7766", "e.moretti@morettimpianti.com",
                                             "linkedin.com/in/elenamoretti"])], None,
                  {"given": "Elena", "family": "Moretti", "org": "Moretti Impianti S.p.A.", "title": "Responsabile commerciale",
                   "emails": ["e.moretti@morettimpianti.com"], "phones": ["cell 3352468100", "work 0309987766"], "city": "Brescia"}))

    # 4) inglese con cognome in maiuscolo e QR MECARD
    mc = "MECARD:N:Walker,James;ORG:Northbridge Surveys Ltd;TEL:+447700900456;EMAIL:j.walker@northbridgesurveys.co.uk;URL:https://northbridgesurveys.co.uk;;"
    f = card()
    text_lines(f, [("James WALKER", font(B, 12), None, 2), ("Chartered Surveyor", font(R, 8.5), "#555", 8),
                   ("Northbridge Surveys Ltd", font(B, 8.5), None, 0), ("M: +44 7700 900456", font(R, 7.5), None, 0),
                   ("j.walker@northbridgesurveys.co.uk", font(R, 7.5), None, 0)], 110, 200)
    draw_qr(f, mc, W - 560, 120, 460)
    cards.append(("en_mecard", [("fronte", f, ["James WALKER", "Chartered Surveyor", "Northbridge Surveys Ltd", "M: +44 7700 900456",
                                               "j.walker@northbridgesurveys.co.uk"])], mc,
                  {"given": "James", "family": "Walker", "org": "Northbridge Surveys Ltd",
                   "emails": ["j.walker@northbridgesurveys.co.uk"], "phones": ["cell 447700900456"]}))

    att = {"nota": "Generato da tools/make_bcard_samples.py: persone, aziende e numeri inventati.", "biglietti": []}
    for i, (cid, sides, qr, exp) in enumerate(cards):
        lati = []
        for name, img, testo in sides:
            fn = f"{cid}_{name}.png"
            img.save(OUT / fn, dpi=(DPI, DPI))
            photo(img, i * 10 + len(lati), TABLES.get(f"{cid}_{name}", (52, 40, 30))).save(OUT / f"{cid}_{name}_foto.jpg", quality=90)
            lati.append({"file": fn, "foto": f"{cid}_{name}_foto.jpg", "testo": "\n".join(testo)})
        att["biglietti"].append({"id": cid, "lati": lati, "qr": qr, "atteso": exp})
    (OUT / "attesi.json").write_bytes(json.dumps(att, ensure_ascii=False, indent=1).encode("utf-8") + b"\n")
    print(f"{len(cards)} biglietti in {OUT}")


if __name__ == "__main__":
    main()
