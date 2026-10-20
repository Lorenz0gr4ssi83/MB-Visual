"""Crea il logo MB Visual partendo dal logo MB Group originale.

Mantiene il marchio "mb" e la linea bianca, sostituisce "GROUP" con "VISUAL".
Output: ui/img/logo.png (trasparente fuori dal quadrato), ui/img/logo-512.png, app.ico
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "logo_mb_group_originale.gif"
GREY = (138, 140, 137)
WHITE = (252, 255, 251)


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size

    # angoli esterni al quadrato arrotondato -> trasparenti
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(im, corner, (0, 0, 0, 0), thresh=60)

    # cancella la scritta GROUP (fascia sotto la linea bianca)
    px = im.load()
    for y in range(201, h):
        for x in range(w):
            if px[x, y][3]:
                px[x, y] = GREY + (px[x, y][3],)

    draw = ImageDraw.Draw(im)
    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 47)
    text = "VISUAL"
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    x = (w - tw) / 2 - box[0]
    y = 208 - box[1] + (35 - th) / 2
    draw.text((x, y), text, font=font, fill=WHITE + (255,))

    out = ROOT / "ui" / "img"
    out.mkdir(parents=True, exist_ok=True)
    im.save(out / "logo.png")
    big = im.resize((512, 512), Image.LANCZOS)
    big.save(out / "logo-512.png")
    big.save(ROOT / "app.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("ok")


if __name__ == "__main__":
    main()
