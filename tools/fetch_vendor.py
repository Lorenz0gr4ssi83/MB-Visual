"""Scarica le librerie JavaScript usate dai visualizzatori in ui/vendor.

Uso:  python tools/fetch_vendor.py
Le versioni sono fissate: cambiarle qui e rilanciare per aggiornare.
"""
import io
import shutil
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "ui" / "vendor"

# (nome cartella, url tarball/zip, prefissi da estrarre)
PACKAGES = [
    ("three", "https://registry.npmjs.org/three/-/three-0.169.0.tgz",
     ["package/build/three.module.js", "package/examples/jsm/"]),
    ("occt", "https://registry.npmjs.org/occt-import-js/-/occt-import-js-0.0.23.tgz",
     ["package/dist/"]),
    ("libredwg", "https://registry.npmjs.org/@mlightcad/libredwg-web/-/libredwg-web-0.7.14.tgz",
     ["package/dist/", "package/wasm/"]),
    ("monaco", "https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.52.2.tgz",
     ["package/min/vs/"]),
    ("docx-preview", "https://registry.npmjs.org/docx-preview/-/docx-preview-0.3.5.tgz",
     ["package/dist/docx-preview.min.js"]),
    ("jszip", "https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz",
     ["package/dist/jszip.min.js"]),
    ("mammoth", "https://registry.npmjs.org/mammoth/-/mammoth-1.8.0.tgz",
     ["package/mammoth.browser.min.js"]),
    ("epubjs", "https://registry.npmjs.org/epubjs/-/epubjs-0.3.93.tgz",
     ["package/dist/epub.min.js"]),
    ("marked", "https://registry.npmjs.org/marked/-/marked-12.0.2.tgz",
     ["package/marked.min.js"]),
    ("xlsx", "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
     ["package/dist/xlsx.full.min.js"]),
    ("web-ifc", "https://registry.npmjs.org/web-ifc/-/web-ifc-0.0.66.tgz",
     ["package/web-ifc-api.js", "package/web-ifc.wasm", "package/web-ifc-mt.wasm"]),
    ("pdfjs", "https://github.com/mozilla/pdf.js/releases/download/v4.10.38/pdfjs-4.10.38-dist.zip",
     [""]),
    ("ag-psd", "https://registry.npmjs.org/ag-psd/-/ag-psd-31.0.2.tgz",
     ["package/dist/bundle.js"]),
    # visualizzatore GIS (ui/js/viewers/gis.js): OpenLayers BSD-2, proj4js MIT, geotiff.js MIT
    ("ol", "https://registry.npmjs.org/ol/-/ol-10.2.1.tgz",
     ["package/dist/ol.js", "package/ol.css", "package/LICENSE.md"]),
    ("proj4", "https://registry.npmjs.org/proj4/-/proj4-2.12.1.tgz",
     ["package/dist/proj4.js", "package/LICENSE.md"]),
    ("geotiff", "https://registry.npmjs.org/geotiff/-/geotiff-2.1.3.tgz",
     ["package/dist-browser/geotiff.js", "package/LICENSE"]),
    # SketchUp .skp senza SketchUp: OpenSKP (MIT) e le sue dipendenze fflate (MIT), earcut (ISC), flatbuffers (Apache-2.0)
    ("openskp", "https://registry.npmjs.org/openskp/-/openskp-1.3.0.tgz",
     ["package/dist/index.mjs", "package/package.json"]),
    ("fflate", "https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz",
     ["package/esm/browser.js", "package/LICENSE"]),
    ("earcut", "https://registry.npmjs.org/earcut/-/earcut-3.0.2.tgz",
     ["package/src/earcut.js", "package/LICENSE"]),
    ("flatbuffers", "https://registry.npmjs.org/flatbuffers/-/flatbuffers-25.9.23.tgz",
     ["package/mjs/", "package/LICENSE"]),
]

# file da aggiungere dopo l'estrazione (il pacchetto npm di openskp non contiene la licenza)
EXTRA = {
    "openskp": [("LICENSE", "https://raw.githubusercontent.com/iamahsanmehmood/openskp/v1.3.0/LICENSE")],
}
# import senza percorso (da bundler) resi relativi: cosi' il modulo si carica anche in un Worker, che non vede l'import map
REWRITE = {
    "openskp": ("dist/index.mjs", {'from "fflate"': 'from "../../fflate/esm/browser.js"',
                                   'from "earcut"': 'from "../../earcut/src/earcut.js"',
                                   'from "flatbuffers"': 'from "../../flatbuffers/mjs/flatbuffers.js"'}),
}
# esportazioni in piu': una sola lettura del file per modello (spigoli, scene) e scena a istanze
APPEND = {
    "openskp": ("dist/index.mjs", "\nexport { parseToRaw as _parseToRaw, buildInstancedSceneFromParsed as _buildInstancedSceneFromParsed };\n"),
}


def download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "mb-visual-fetch"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def strip_package(name: str) -> str:
    return name[len("package/"):] if name.startswith("package/") else name


def extract(name: str, url: str, prefixes: list[str]) -> None:
    dest = VENDOR / name
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    data = download(url)
    count = 0
    if url.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if info.is_dir() or info.filename.endswith(".map"):
                    continue
                if any(info.filename.startswith(p) for p in prefixes):
                    out = dest / info.filename
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(z.read(info))
                    count += 1
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            for m in t.getmembers():
                if not m.isfile() or m.name.endswith(".map"):
                    continue
                if any(m.name.startswith(p) for p in prefixes):
                    out = dest / strip_package(m.name)
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(t.extractfile(m).read())
                    count += 1
    for rel, extra_url in EXTRA.get(name, []):
        (dest / rel).write_bytes(download(extra_url))
        count += 1
    if name in REWRITE:
        rel, subs = REWRITE[name]
        text = (dest / rel).read_text(encoding="utf-8")
        for old, new in subs.items():
            if old not in text:
                raise SystemExit(f"{name}: '{old}' non trovato in {rel} (versione cambiata?)")
            text = text.replace(old, new)
        if name in APPEND and APPEND[name][0] == rel:
            text += APPEND[name][1]
        (dest / rel).write_text(text, encoding="utf-8")
    print(f"{name}: {count} file")


def main() -> int:
    VENDOR.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    for name, url, prefixes in PACKAGES:
        if only and name not in only:
            continue
        extract(name, url, prefixes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
