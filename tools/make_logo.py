"""Crea il logo MB Desk partendo dal logo MB Group originale.

Mantiene il marchio "mb" e la linea bianca, sostituisce "GROUP" con "DESK".
Output: ui/img/logo.png (trasparente fuori dal quadrato), ui/img/logo-512.png, app.ico
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "logo_mb_group_originale.gif"
GREY = (138, 140, 137)
WHITE = (252, 255, 251)


def icon_frame(big: Image.Image, s: int) -> Image.Image:
    """Un formato dell'icona: riduzione in due passi (meno sfocata di una sola) e leggera nitidezza sotto i 64 px."""
    from PIL import ImageFilter
    im = big
    while im.width > s * 2:
        im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
    im = im.resize((s, s), Image.LANCZOS)
    if s < 64:
        rgb = im.convert("RGB").filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=1))
        rgb.putalpha(im.getchannel("A"))
        im = rgb
    return im


def tile(text: str):
    """Piastrella del logo con la scritta sotto la linea (DESK per l'app, ADMIN per MB Desk Admin): (immagine, maschera)."""
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
    return im, mask


def main() -> None:
    im, mask = tile("DESK")
    w, h = im.size
    k = 4
    out = ROOT / "ui" / "img"
    out.mkdir(parents=True, exist_ok=True)
    im.save(out / "logo.png")
    big = im.resize((512, 512), Image.LANCZOS)
    big.save(out / "logo-512.png")
    # icona di Windows: fino a 32 px una versione semplificata (solo "mb", tratti ingrossati, senza la scritta VISUAL
    # che a quelle dimensioni diventa una riga grigia e fa sembrare l'icona un quadrato vuoto)
    from PIL import ImageFilter
    small = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    small.putalpha(0)
    small.paste(GREY + (255,), (0, 0, w, h), mask)
    glyph = im.crop((0, 0, w, 200))
    white = glyph.convert("L").point(lambda v: 255 if v > 200 else 0)
    # via i residui chiari del bordo originale (angoli), prima di ingrossare i tratti
    edge = Image.new("L", (w * k, 200 * k), 0)
    ImageDraw.Draw(edge).rounded_rectangle((12 * k, 8 * k, (w - 12) * k - 1, 200 * k - 1), radius=30 * k, fill=255)
    white = ImageChops.multiply(white, edge.resize((w, 200), Image.LANCZOS).point(lambda v: 255 if v > 128 else 0))
    white = white.filter(ImageFilter.MaxFilter(7))
    gw, gh = int(w * 0.80), int(200 * 0.80)
    white = white.resize((gw, gh), Image.LANCZOS)
    small.paste(WHITE + (255,), ((w - gw) // 2, (h - gh) // 2 + 4), white)
    small.putalpha(ImageChops.multiply(small.getchannel("A"), mask))
    small.save(out / "logo-small.png")
    # icona di Windows: lo stesso logo completo in tutti i formati (anche 16-32 px della barra delle applicazioni),
    # rimpicciolito dal 512 px: richiesta dell'utente, la versione semplificata "solo mb" sembrava un'altra icona
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    imgs = [icon_frame(big, s) for s in sizes]
    imgs[-1].save(ROOT / "app.ico", sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
    # MB Desk Admin: stesso logo con la scritta ADMIN (richiesta dell'utente: niente chiave) -> admin.ico e logo per il telefono
    adm = tile("ADMIN")[0].resize((512, 512), Image.LANCZOS)
    adm.save(ROOT / "admin" / "logo-admin-512.png")
    imgs = [icon_frame(adm, s) for s in sizes]
    imgs[-1].save(ROOT / "admin" / "admin.ico", sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
    print("ok")


if __name__ == "__main__":
    main()
