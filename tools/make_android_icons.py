"""Icone e schermata d'avvio dell'app Android (android-app) dal logo di MB Desk (ui/img/logo-512.png).

Uso: python tools/make_android_icons.py
- mipmap-*/ic_launcher.png e ic_launcher_round.png (logo intero), ic_launcher_foreground.png (logo nella zona sicura
  dell'icona adattiva, sfondo grafite #0f1114);
- drawable*/splash.png (logo al centro su grafite) per tutte le densita' e i due orientamenti.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android-app" / "android" / "app" / "src" / "main" / "res"
BG = (15, 17, 20, 255)
DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def main() -> None:
    logo = Image.open(ROOT / "ui" / "img" / "logo-512.png").convert("RGBA")
    for d, k in DENS.items():
        s = round(48 * k)
        icon = logo.resize((s, s), Image.LANCZOS)
        out = RES / f"mipmap-{d}"
        out.mkdir(parents=True, exist_ok=True)
        icon.save(out / "ic_launcher.png")
        # tonda: logo dentro un cerchio grafite
        r = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        m = Image.new("L", (s * 4, s * 4), 0)
        ImageDraw.Draw(m).ellipse((0, 0, s * 4 - 1, s * 4 - 1), fill=255)
        m = m.resize((s, s), Image.LANCZOS)
        r.paste(BG, (0, 0, s, s), m)
        inner = logo.resize((round(s * 0.72),) * 2, Image.LANCZOS)
        r.alpha_composite(inner, ((s - inner.width) // 2, (s - inner.height) // 2))
        r.save(out / "ic_launcher_round.png")
        # icona adattiva: 108 dp, contenuto nei 66 dp centrali
        f = round(108 * k)
        fg = Image.new("RGBA", (f, f), (0, 0, 0, 0))
        inner = logo.resize((round(f * 0.6),) * 2, Image.LANCZOS)
        fg.alpha_composite(inner, ((f - inner.width) // 2, (f - inner.height) // 2))
        fg.save(out / "ic_launcher_foreground.png")
    (RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0F1114</color>\n</resources>\n',
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
