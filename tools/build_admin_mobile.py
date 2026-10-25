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
GREY = (138, 140, 137, 255)  # grigio della piastrella del logo


def icon(size: int) -> bytes:
    s = 1024  # disegno grande e riduzione finale: bordi puliti
    # grigio a tutto campo come la piastrella del logo: niente fondo scuro che, ritagliato da Android/iOS, lasciava bordi neri
    im = Image.new("RGBA", (s, s), GREY)
    logo = Image.open(ROOT / "ui" / "img" / "logo-512.png").convert("RGBA").resize((540, 540), Image.LANCZOS)
    im.alpha_composite(logo, (180, 150))  # dentro la zona sicura delle icone "maskable" (cerchio dell'80%)
    d = ImageDraw.Draw(im)
    cx, cy, r = 735, 735, 95  # tondo arancione in basso a destra con una chiave bianca, anch'esso nella zona sicura
    d.ellipse((cx - r - 14, cy - r - 14, cx + r + 14, cy + r + 14), fill=GREY)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ORANGE)
    w = (255, 255, 255, 255)
    k = r / 165
    d.ellipse((cx - 105 * k, cy - 54 * k, cx + 3 * k, cy + 54 * k), outline=w, width=round(30 * k))  # anello della chiave
    d.rectangle((cx - 4 * k, cy - 15 * k, cx + 110 * k, cy + 15 * k), fill=w)                      # gambo
    d.rectangle((cx + 60 * k, cy + 8 * k, cx + 84 * k, cy + 58 * k), fill=w)                      # denti
    d.rectangle((cx + 94 * k, cy + 8 * k, cx + 118 * k, cy + 44 * k), fill=w)
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
