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

    # bordo pulito: il riempimento a soglia lascia lungo la curva un alone chiaro (sfondo bianco dell'originale).
    # Maschera a quadrato arrotondato rientrata di 3 px, disegnata a risoluzione 4x per un bordo liscio.
    k, inset, radius = 4, 3, 36
    mask = Image.new("L", (w * k, h * k), 0)
    ImageDraw.Draw(mask).rounded_rectangle((inset * k, inset * k, (w - inset) * k - 1, (h - inset) * k - 1), radius=radius * k, fill=255)
    mask = mask.resize((w, h), Image.LANCZOS)
    from PIL import ImageChops
    im.putalpha(ImageChops.multiply(im.getchannel("A"), mask))
    # i pixel del bordo semitrasparente prendono il grigio pieno (niente frange chiare quando si ingrandisce)
    px = im.load()
    for yy in range(h):
        for xx in range(w):
            r, g, b, a = px[xx, yy]
            if 0 < a < 255 and (xx < inset + radius or xx > w - inset - radius - 1 or yy < inset + radius or yy > h - inset - radius - 1):
                if min(r, g, b) > 170 and (xx < inset + 6 or xx > w - inset - 7 or yy < inset + 6 or yy > h - inset - 7):
                    px[xx, yy] = GREY + (a,)

    out = ROOT / "ui" / "img"
    out.mkdir(parents=True, exist_ok=True)
    im.save(out / "logo.png")
    big = im.resize((512, 512), Image.LANCZOS)
    big.save(out / "logo-512.png")
    big.save(ROOT / "app.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("ok")


if __name__ == "__main__":
    main()
