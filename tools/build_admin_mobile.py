"""App per telefono di MB Desk Admin: impacchetta pagina, service worker e icone in server/src/adminui.js.

Uso:  python tools/build_admin_mobile.py
Sorgenti: server/adminapp/index.html e sw.js; icone generate dal logo (ui/img/logo-512.png) con un tondo arancione con la
chiave, per distinguerla dall'app MB Desk sulla schermata Home. Il modulo generato si pubblica con il Worker
(tools/license_setup.py server, poi wrangler deploy).
"""
import base64
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "server" / "adminapp"
OUT = ROOT / "server" / "src" / "adminui.js"
ORANGE = (240, 125, 46, 255)


def icon(size: int) -> bytes:
    s = 1024  # disegno grande e riduzione finale: bordi puliti
    im = Image.new("RGBA", (s, s), (23, 25, 27, 255))  # sfondo pieno: su iPhone la trasparenza diventerebbe nera
    logo = Image.open(ROOT / "ui" / "img" / "logo-512.png").convert("RGBA").resize((700, 700), Image.LANCZOS)
    im.alpha_composite(logo, (60, 60))  # logo in alto a sinistra: il tondo non copre la scritta
    d = ImageDraw.Draw(im)
    cx, cy, r = 830, 830, 165  # tondo arancione in basso a destra con una chiave bianca
    d.ellipse((cx - r - 18, cy - r - 18, cx + r + 18, cy + r + 18), fill=(23, 25, 27, 255))
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ORANGE)
    w = (255, 255, 255, 255)
    d.ellipse((cx - 105, cy - 54, cx + 3, cy + 54), outline=w, width=30)       # anello della chiave
    d.rectangle((cx - 4, cy - 15, cx + 110, cy + 15), fill=w)                 # gambo
    d.rectangle((cx + 60, cy + 8, cx + 84, cy + 58), fill=w)                 # denti
    d.rectangle((cx + 94, cy + 8, cx + 118, cy + 44), fill=w)
    out = io.BytesIO()
    im.resize((size, size), Image.LANCZOS).save(out, "PNG", optimize=True)
    return out.getvalue()


def main() -> int:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    sw = (SRC / "sw.js").read_text(encoding="utf-8")
    i192, i512 = (base64.urlsafe_b64encode(icon(n)).decode().rstrip("=") for n in (192, 512))
    js = ("// File generato da tools/build_admin_mobile.py: non modificarlo a mano (sorgenti in server/adminapp/).\n"
          f"export const ADMIN_HTML = {json.dumps(html, ensure_ascii=False)};\n"
          f"export const ADMIN_SW = {json.dumps(sw, ensure_ascii=False)};\n"
          f"export const ICON_192 = \"{i192}\";\n"
          f"export const ICON_512 = \"{i512}\";\n")
    OUT.write_bytes(js.encode("utf-8"))
    print(f"{OUT.relative_to(ROOT)}: {len(js) // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
