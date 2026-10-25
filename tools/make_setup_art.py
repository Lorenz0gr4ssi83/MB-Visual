"""Pagine dei componenti del programma di installazione: icone, immagini e testi generati dal registro unico.

Legge ui/components.json (componenti e profili) e i testi comp.* di ui/i18n/it.json ed en.json, scrive in <uscita>:
  componenti.iss      [Types], [Components], [Files] delle icone e [CustomMessages] it/en (incluso da installer/mbvisual.iss)
  comp_<id>_<lato>.bmp icone dei componenti (piastrella grafite, tratto arancione MB), 48 e 96 px
  wizard_<l>x<a>.png  immagine laterale (pagina finale), small_<lato>.png logo in alto a destra
Uso: python tools/make_setup_art.py <uscita>   (lo chiama tools/build_setup.py; serve il venv dell'app: Pillow e PyMuPDF)
"""
import json
import sys
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BG = (43, 43, 43)            # sfondo delle pagine del setup con WizardStyle=modern dark (#2b2b2b)
TILE_TOP, TILE_BOT = (39, 44, 51), (15, 17, 20)   # --chrome-4 -> --chrome
ACCENT = "#F07D2E"
PROFILES_INNO = {"completo": "completo", "studio": "studio", "impresa": "impresa", "ufficio": "ufficio"}


def svg_icon(inner: str, size: int) -> Image.Image:
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="{size}" height="{size}">'
           f'<g fill="none" stroke="{ACCENT}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{inner}</g></svg>')
    doc = pymupdf.open(stream=svg.encode(), filetype="svg")
    pix = doc[0].get_pixmap(alpha=True, matrix=pymupdf.Matrix(4, 4))
    im = Image.frombytes("RGBA", (pix.width, pix.height), pix.samples)
    return im.resize((size, size), Image.LANCZOS)


def tile(inner: str, side: int) -> Image.Image:
    """Piastrella arrotondata con sfumatura grafite e icona arancione, su fondo BG (BMP senza trasparenza)."""
    k = 4  # disegno a risoluzione 4x poi riduzione: bordi morbidi
    S = side * k
    base = Image.new("RGB", (S, S), BG)
    grad = Image.new("RGB", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TILE_TOP, TILE_BOT)))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.26), fill=255)
    base.paste(grad, (0, 0), mask)
    ImageDraw.Draw(base).rounded_rectangle([k, k, S - 1 - k, S - 1 - k], radius=int(S * 0.24), outline=(48, 54, 62), width=k)
    base = base.resize((side, side), Image.LANCZOS)
    ic = svg_icon(inner, int(side * 0.56))
    base.paste(ic, ((side - ic.width) // 2, (side - ic.height) // 2), ic)
    return base


def wizard_image(w: int, h: int) -> Image.Image:
    """Immagine laterale: grafite con griglia tecnica tenue, logo al centro e linea arancione."""
    im = Image.new("RGB", (w, h), (15, 17, 20))
    d = ImageDraw.Draw(im)
    step = max(8, w // 14)
    for x in range(0, w, step):
        d.line([(x, 0), (x, h)], fill=(24, 27, 31))
    for y in range(0, h, step):
        d.line([(0, y), (w, y)], fill=(24, 27, 31))
    logo = Image.open(ROOT / "ui" / "img" / "logo-512.png").convert("RGBA")
    side = int(w * 0.62)
    logo = logo.resize((side, side), Image.LANCZOS)
    y0 = int(h * 0.36) - side // 2
    im.paste(logo, ((w - side) // 2, y0), logo)
    d.rectangle([(w - side) // 2, y0 + side + max(6, h // 40), (w - side) // 2 + side // 3, y0 + side + max(6, h // 40) + max(2, h // 160)], fill=(240, 125, 46))
    return im


def small_image(side: int) -> Image.Image:
    im = Image.new("RGB", (side, side), BG)
    logo = Image.open(ROOT / "ui" / "img" / "logo-512.png").convert("RGBA").resize((side, side), Image.LANCZOS)
    im.paste(logo, (0, 0), logo)
    return im


def iss_escape(s: str) -> str:
    # CustomMessages: %n = a capo, i segni % letterali vanno raddoppiati
    return s.replace("%", "%%").replace("\n", "%n")


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "installer" / "build"
    out.mkdir(parents=True, exist_ok=True)
    reg = json.loads((ROOT / "ui" / "components.json").read_text(encoding="utf-8"))
    tr = {lang: json.loads((ROOT / "ui" / "i18n" / f"{lang}.json").read_text(encoding="utf-8")) for lang in ("it", "en")}
    comps = reg["components"]
    ids = [c["id"] for c in comps]
    optional = [c["id"] for c in comps if not c.get("fixed")]
    profiles = [p["id"] for p in reg["profiles"]]
    members = {p["id"]: (optional if p["comps"] == "*" else p["comps"]) for p in reg["profiles"]}

    for c in comps:
        for side in (48, 96):
            tile(c["icon"], side).save(out / f"comp_{c['id']}_{side}.bmp")
    # icona dei profili (pannello a destra quando si sceglie un profilo): il logo su piastrella
    for side in (48, 96):
        small_image(side).save(out / f"comp_profilo_{side}.bmp")
    for w, h in ((164, 314), (205, 392), (246, 471), (328, 628)):
        wizard_image(w, h).save(out / f"wizard_{w}x{h}.png")
    for side in (55, 69, 83, 110, 138):
        small_image(side).save(out / f"small_{side}.png")

    L = ["; GENERATO da tools/make_setup_art.py dal registro ui/components.json e dai testi comp.* di ui/i18n: non modificare a mano.",
         f'#define CompIds "{",".join(ids)}"', f'#define CompOptional "{",".join(optional)}"', f'#define CompProfiles "{",".join(profiles)}"',
         # id interni delle versioni precedenti -> applicazione (per riprendere la scelta salvata nel registro)
         '#define CompAliases "' + ";".join(c["id"] + "=" + "|".join(c.get("aliases", [])) for c in comps if not c.get("fixed")) + '"',
         "", "[Types]"]
    for p in profiles:
        L.append(f'Name: "{p}"; Description: "{{cm:Prof_{p}}}"')
    L.append('Name: "personalizzato"; Description: "{cm:Prof_personalizzato}"; Flags: iscustom')
    L += ["", "[Components]"]
    for c in comps:
        if c.get("fixed"):
            L.append(f'Name: "{c["id"]}"; Description: "{{cm:Comp_{c["id"]}}}"; Types: {" ".join(profiles)} personalizzato; Flags: fixed')
        else:
            ts = [p for p in profiles if c["id"] in members[p]]
            L.append(f'Name: "{c["id"]}"; Description: "{{cm:Comp_{c["id"]}}}"; Types: {" ".join(ts)}')
    L += ["", "[Files]"]
    for c in comps + [{"id": "profilo"}]:
        for side in (48, 96):
            L.append(f'Source: "{{#ArtDir}}\\comp_{c["id"]}_{side}.bmp"; Flags: dontcopy')
    L += ["", "[CustomMessages]"]
    for lang in ("it", "en"):
        T = tr[lang]
        for c in comps:
            L.append(f'{lang}.Comp_{c["id"]}={iss_escape(T[f"comp.{c["id"]}.nome"])}')
            L.append(f'{lang}.CompDesc_{c["id"]}={iss_escape(T[f"comp.{c["id"]}.desc"])}')
        for p in profiles + ["personalizzato"]:
            L.append(f'{lang}.Prof_{p}={iss_escape(T[f"comp.prof.{p}.nome"])}')
            L.append(f'{lang}.ProfDesc_{p}={iss_escape(T["comp.intro"])}')  # in cima alla pagina: cosa significa scegliere
        L.append(f'{lang}.CompSempre={iss_escape(T["comp.sempre"])}')
        L.append(f'{lang}.CompSottotitolo={iss_escape(T["comp.sottotitolo"])}')
    (out / "componenti.iss").write_text("\n".join(L) + "\n", encoding="utf-8-sig")
    print(f"Pagine dei componenti pronte in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
