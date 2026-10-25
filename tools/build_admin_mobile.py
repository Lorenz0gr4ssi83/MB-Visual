"""App per telefono di MB Desk Admin: impacchetta pagina, service worker e icone in server/src/adminui.js.

Uso:  python tools/build_admin_mobile.py
Sorgenti: server/adminapp/index.html e sw.js; icone dal logo con la scritta ADMIN (admin/logo-admin-512.png, creato da
tools/make_logo.py), per distinguerla dall'app MB Desk sulla schermata Home. Il modulo generato si pubblica con il Worker
(tools/license_setup.py server, poi wrangler deploy).
"""
import base64
import io
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "server" / "adminapp"
OUT = ROOT / "server" / "src" / "adminui.js"
GREY = (138, 140, 137, 255)  # grigio della piastrella del logo


def icon(size: int) -> bytes:
    s = 1024  # disegno grande e riduzione finale: bordi puliti
    # grigio a tutto campo come la piastrella del logo (niente fondo scuro che, ritagliato da Android/iOS, lasciava bordi neri);
    # logo con la scritta ADMIN (tools/make_logo.py) nella zona sicura delle icone "maskable"
    im = Image.new("RGBA", (s, s), GREY)
    logo = Image.open(ROOT / "admin" / "logo-admin-512.png").convert("RGBA").resize((720, 720), Image.LANCZOS)
    im.alpha_composite(logo, ((s - 720) // 2, (s - 720) // 2))
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
