"""Icone e schermata d'avvio dell'app Android (android-app) dal logo di MB Desk (ui/img/logo-512.png).

Uso: python tools/make_android_icons.py
- mipmap-*/ic_launcher.png e ic_launcher_round.png, ic_launcher_foreground.png (marchio nella zona sicura dell'icona
  adattiva): tutte grigie a tutto campo come la piastrella del logo, senza fondo scuro attorno;
- drawable*/splash.png (logo al centro su grafite) per tutte le densita' e i due orientamenti.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android-app" / "android" / "app" / "src" / "main" / "res"
BG = (15, 17, 20, 255)
GREY = (138, 140, 137, 255)  # grigio della piastrella del logo
DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def main() -> None:
    logo = Image.open(ROOT / "ui" / "img" / "logo-512.png").convert("RGBA")
    # il logo e' una piastrella grigia con gli angoli arrotondati: le icone sono GRIGIE a tutto campo (niente fondo scuro
    # attorno, che Android mostrava come bordi neri negli angoli e ai lati) con il marchio al centro
    for d, k in DENS.items():
        s = round(48 * k)
        out = RES / f"mipmap-{d}"
        out.mkdir(parents=True, exist_ok=True)
        full = Image.new("RGBA", (s * 4, s * 4), GREY)
        inner = logo.resize((round(s * 4 * 0.78),) * 2, Image.LANCZOS)
        full.alpha_composite(inner, ((s * 4 - inner.width) // 2, (s * 4 - inner.height) // 2))
        # quadrata (Android senza icone adattive): angoli arrotondati come la piastrella del logo
        m = Image.new("L", (s * 4, s * 4), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, s * 4 - 1, s * 4 - 1), radius=round(s * 4 * 0.2), fill=255)
        sq = Image.new("RGBA", (s * 4, s * 4), (0, 0, 0, 0))
        sq.paste(full, (0, 0), m)
        sq.resize((s, s), Image.LANCZOS).save(out / "ic_launcher.png")
        m = Image.new("L", (s * 4, s * 4), 0)
        ImageDraw.Draw(m).ellipse((0, 0, s * 4 - 1, s * 4 - 1), fill=255)
        rd = Image.new("RGBA", (s * 4, s * 4), (0, 0, 0, 0))
        rd.paste(full, (0, 0), m)
        rd.resize((s, s), Image.LANCZOS).save(out / "ic_launcher_round.png")
        # icona adattiva: 108 dp con fondo grigio (colore sotto), marchio nella zona sicura centrale
        f = round(108 * k)
        fg = Image.new("RGBA", (f, f), (0, 0, 0, 0))
        inner = logo.resize((round(f * 0.52),) * 2, Image.LANCZOS)
        fg.alpha_composite(inner, ((f - inner.width) // 2, (f - inner.height) // 2))
        fg.save(out / "ic_launcher_foreground.png")
    (RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#%02X%02X%02X</color>\n</resources>\n' % GREY[:3],
        encoding="utf-8")
    # schermate d'avvio
    for folder in [p for p in RES.iterdir() if p.is_dir() and p.name.startswith("drawable")]:
        sp = folder / "splash.png"
        if not sp.exists():
            continue
        w, h = Image.open(sp).size
        im = Image.new("RGBA", (w, h), BG)
        side = round(min(w, h) * 0.32)
        lg = logo.resize((side, side), Image.LANCZOS)
        im.alpha_composite(lg, ((w - side) // 2, (h - side) // 2))
        im.convert("RGB").save(sp)
    print("icone e schermate d'avvio aggiornate")


if __name__ == "__main__":
    main()
