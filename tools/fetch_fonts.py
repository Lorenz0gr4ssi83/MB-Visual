"""Scarica i caratteri dell'interfaccia in ui/fonts (una volta sola: i file stanno nel repository e nell'app).

Caratteri con licenza SIL Open Font License 1.1 (uso commerciale e inclusione nei programmi consentiti):
- IBM Plex Sans 400/500/600/700 e corsivo 400 (interfaccia)
- IBM Plex Mono 400/500/600 (misure, coordinate, badge)
- Space Grotesk variabile 300-700 (titoli)
Fonte: pacchetti Fontsource su npm (versioni fisse), sottoinsiemi latin + latin-ext (italiano, inglese, spagnolo,
francese, tedesco). La licenza di ogni famiglia e' copiata accanto ai file.
"""
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "ui" / "fonts"
CDN = "https://cdn.jsdelivr.net/npm/"
FAMILIES = [
    ("@fontsource/ibm-plex-sans@5.3.0", "ibm-plex-sans", [("400", "normal"), ("500", "normal"), ("600", "normal"), ("700", "normal"), ("400", "italic")]),
    ("@fontsource/ibm-plex-mono@5.3.0", "ibm-plex-mono", [("400", "normal"), ("500", "normal"), ("600", "normal")]),
    ("@fontsource-variable/space-grotesk@5.3.0", "space-grotesk", [("wght", "normal")]),
]
SUBSETS = ["latin", "latin-ext"]


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for pkg, fam, styles in FAMILIES:
        for sub in SUBSETS:
            for w, st in styles:
                name = f"{fam}-{sub}-{w}-{st}.woff2"
                data = get(f"{CDN}{pkg}/files/{name}")
                (OUT / name).write_bytes(data)
                print(f"{name}: {len(data) // 1024} KB")
        (OUT / f"{fam}-LICENSE.txt").write_bytes(get(f"{CDN}{pkg}/LICENSE"))


if __name__ == "__main__":
    main()
