"""Crea la web app installabile (PWA) di MB Visual nella cartella docs/ (pubblicata da GitHub Pages).

Uso:  python tools/build_web.py
- usa la stessa interfaccia di ui/ con il motore nel browser (ui/js/webapi.js) al posto di quello Python
- elenco formati ridotto a quelli che si aprono davvero nel browser (docs/formats.json)
- manifest, service worker (uso offline, "Condividi > MB Visual" sul telefono), icone
"""
import io
import json
import sys
import re
import shutil
import tarfile
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
FINAL = ROOT / "docs"
# si costruisce fuori da OneDrive (che blocca i file durante la sincronizzazione) e poi si allinea docs/ con robocopy
OUT = Path.home() / ".mbvisual" / "webbuild"
CACHE = Path.home() / ".mbvisual" / "webvendor"
VERSION = "2026.10.21-8"

# librerie usate solo dalla web app: (cartella, tarball npm, {file nel pacchetto: destinazione})
WEB_LIBS = [
    ("pdf-lib", "https://registry.npmjs.org/pdf-lib/-/pdf-lib-1.17.1.tgz", {"package/dist/pdf-lib.min.js": "pdf-lib.min.js"}),
    ("sqljs", "https://registry.npmjs.org/sql.js/-/sql.js-1.10.3.tgz", {"package/dist/sql-wasm.js": "sql-wasm.js", "package/dist/sql-wasm.wasm": "sql-wasm.wasm"}),
    ("libarchive", "https://registry.npmjs.org/libarchive.js/-/libarchive.js-2.0.2.tgz",
     {"package/dist/libarchive.js": "libarchive.js", "package/dist/worker-bundle.js": "worker-bundle.js", "package/dist/libarchive.wasm": "libarchive.wasm"}),
    ("postal-mime", "https://registry.npmjs.org/postal-mime/-/postal-mime-2.3.2.tgz", {"package/src/": "src/"}),
    ("utif", "https://registry.npmjs.org/utif/-/utif-3.1.0.tgz", {"package/UTIF.js": "UTIF.js"}),
    ("heic2any", "https://registry.npmjs.org/heic2any/-/heic2any-0.0.4.tgz", {"package/dist/heic2any.min.js": "heic2any.min.js"}),
    ("html-docx", "https://registry.npmjs.org/html-docx-js/-/html-docx-js-0.3.1.tgz", {"package/dist/html-docx.js": "html-docx.js"}),
]

# estensioni che la web app apre davvero (per categoria del registro); le categorie assenti non sono disponibili
WEB_EXTS = {
    "pdf": "*", "signed": "*", "word": "*", "sheet": "*", "pptx": "*", "text": "*", "markdown": "*", "svg": "*",
    "html": ["html", "htm", "xhtml", "shtml"],
    "image": ["png", "apng", "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "gif", "webp", "bmp", "dib", "ico", "cur", "avif", "avifs",
              "tif", "tiff", "heic", "heif", "hif", "heics", "heifs"],
    "media": ["mp4", "m4v", "mov", "webm", "ogv", "3gp", "mkv"],
    "audio": ["mp3", "wav", "wave", "flac", "ogg", "oga", "opus", "m4a", "aac"],
    "cad2d": ["dwg", "dxf", "dwt"], "cad3d": "*", "mesh3d": "*",
    "archive": ["zip", "zipx", "7z", "rar", "tar", "ova", "gz", "gzip", "tgz", "tpz", "bz2", "bzip2", "tbz", "tbz2", "xz", "txz", "lzma", "z", "taz",
                "cab", "lzh", "lha", "cpio", "rpm", "deb", "ar", "a", "iso", "xar", "pkg", "xip", "jar", "war", "ear", "apk", "aab", "xapk", "ipa",
                "appx", "msix", "appxbundle", "nupkg", "vsix", "xpi", "whl", "egg", "cbz", "cbr", "cb7"],
    "email": ["eml", "mbox", "mbx"], "ebook": "*", "font": ["ttf", "otf", "woff", "woff2"], "database": "*",
}
WEB_NOTES = {
    "media": "Riproduzione dei formati supportati dal browser del dispositivo (la conversione di altri formati e' nella versione per PC)",
    "audio": "Riproduzione con forma d'onda dei formati supportati dal browser del dispositivo",
    "image": "Zoom, rotazione, ritaglio, regolazioni, disegno e testo; salvataggio in PNG, JPG, WEBP o TIFF",
    "archive": "Contenuto ed estrazione dei file; modifica (aggiunta, eliminazione, rinomina) solo per gli archivi ZIP",
    "email": "Messaggi EML e caselle MBOX con allegati (i .msg di Outlook si aprono nella versione per PC)",
}


def fetch(url: str) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / url.rsplit("/", 1)[1]
    if not f.exists():
        req = urllib.request.Request(url, headers={"User-Agent": "mb-visual-build"})
        with urllib.request.urlopen(req, timeout=300) as r:
            f.write_bytes(r.read())
    return f.read_bytes()


def web_libs(vendor: Path) -> None:
    for name, url, mapping in WEB_LIBS:
        dest = vendor / name
        dest.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(fetch(url)), mode="r:gz") as t:
            for m in t.getmembers():
                if not m.isfile():
                    continue
                for src, dst in mapping.items():
                    if m.name == src or (src.endswith("/") and m.name.startswith(src)):
                        out = dest / (dst + m.name[len(src):] if src.endswith("/") else dst)
                        out.parent.mkdir(parents=True, exist_ok=True)
                        out.write_bytes(t.extractfile(m).read())


def web_registry() -> dict:
    reg = json.loads((UI / "formats.json").read_text(encoding="utf-8"))
    cats = []
    for c in reg["categories"]:
        allowed = WEB_EXTS.get(c["id"])
        if not allowed:
            continue
        c = dict(c)
        c["exts"] = list(c["exts"]) if allowed == "*" else [e for e in c["exts"] if e in allowed]
        if c["id"] in WEB_NOTES:
            c["edit"] = WEB_NOTES[c["id"]]
        c.pop("requires", None)
        if c["id"] == "cad2d":
            c["edit"] = "Accensione/spegnimento layer, misure, esportazione SVG/PNG/PDF; per DXF modifica del contenuto testuale"
        if c["id"] == "signed":
            c["view"] = c["view"].replace(" (anche firme multiple annidate)", "") + " - verifica eseguita nel browser"
        cats.append(c)
    reg["categories"] = cats
    reg["_nota"] = "Registro della web app: solo i formati che si aprono nel browser. Generato da tools/build_web.py."
    return reg


def patch_js(text: str) -> str:
    # i percorsi assoluti /vendor/... diventano relativi alla pagina (GitHub Pages pubblica in una sottocartella)
    text = text.replace("`/vendor/", "`${window.MBV_ROOT}vendor/")
    text = re.sub(r'(["\'])/vendor/', lambda m: "window.MBV_ROOT + " + m.group(1) + "vendor/", text)
    return text


HEAD = """<meta name="theme-color" content="#1e2225">
<meta name="description" content="MB Visual - visualizzatore di documenti, disegni CAD, modelli 3D e BIM di MB Engineering">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="img/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<script>window.MBV_WEB = true; window.MBV_ROOT = new URL(".", location.href).href;
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js"));</script>
"""

MANIFEST = {
    "name": "MB Visual", "short_name": "MB Visual", "id": "./", "start_url": "./", "scope": "./", "display": "standalone",
    "background_color": "#eff0ee", "theme_color": "#1e2225", "lang": "it",
    "description": "Visualizzatore di documenti, disegni CAD, modelli 3D e BIM, firme digitali e archivi",
    "icons": [{"src": "img/icon-192.png", "sizes": "192x192", "type": "image/png"},
              {"src": "img/icon-512.png", "sizes": "512x512", "type": "image/png"},
              {"src": "img/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
    "share_target": {"action": "./condividi", "method": "POST", "enctype": "multipart/form-data",
                     "params": {"files": [{"name": "file", "accept": ["*/*"]}]}},
}

SW = r"""// Service worker di MB Visual: uso offline (cache) e ricezione dei file condivisi da altre app
const VERSION = "__VERSION__";
const CORE = ["./", "index.html", "css/app.css", "js/app.js", "js/core.js", "js/webapi.js", "formats.json", "img/logo.png", "img/icon-192.png", "manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open("mbv-" + VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("mbv-") && k !== "mbv-" + VERSION && k !== "mbv-condivisi").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/condividi")) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open("mbv-condivisi");
      let i = 0;
      for (const f of form.getAll("file")) {
        await cache.put(new Request("./condiviso/" + (i++) + "-" + Date.now()), new Response(f, { headers: { "X-Nome": encodeURIComponent(f.name || "file") } }));
      }
      return Response.redirect("./?condivisi=1", 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // prima la cache (le librerie pesanti vengono salvate al primo uso), poi la rete
  e.respondWith(caches.open("mbv-" + VERSION).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: url.pathname.endsWith(".html") || url.pathname.endsWith("/") });
    if (hit) return hit;
    const r = await fetch(e.request);
    if (r.ok && r.type === "basic") c.put(e.request, r.clone());
    return r;
  }).catch(() => caches.match("index.html")));
});
"""


def icons(img_dir: Path) -> None:
    logo = Image.open(UI / "img" / "logo-512.png").convert("RGBA")
    for s in (192, 512):
        logo.resize((s, s), Image.LANCZOS).save(img_dir / f"icon-{s}.png")
    # icona "maskable": marchio ridotto al centro su fondo grigio del logo
    bg = Image.new("RGBA", (512, 512), (138, 140, 137, 255))
    small = logo.resize((380, 380), Image.LANCZOS)
    bg.alpha_composite(small, (66, 66))
    bg.save(img_dir / "icon-maskable-512.png")


def main() -> None:
    global OUT
    import time
    # cartella nuova a ogni compilazione (Windows a volte trattiene le cartelle appena usate); le vecchie si rimuovono se possibile
    for old in OUT.parent.glob("webbuild*"):
        shutil.rmtree(old, ignore_errors=True)
    OUT = OUT.parent / f"webbuild-{int(time.time())}"
    shutil.copytree(UI, OUT, ignore=shutil.ignore_patterns("formats.json", "*.map"))
    web_libs(OUT / "vendor")
    for js in (OUT / "js").rglob("*.js"):
        js.write_text(patch_js(js.read_text(encoding="utf-8")), encoding="utf-8")
    html = (OUT / "index.html").read_text(encoding="utf-8")
    html = html.replace('<link rel="icon" href="img/logo.png">', '<link rel="icon" href="img/logo.png">\n' + HEAD)
    html = html.replace('"/vendor/', '"./vendor/')
    html = html.replace('<script type="module" src="js/app.js"></script>', '<script type="module" src="js/webapi.js"></script>\n<script type="module" src="js/app.js"></script>')
    html = html.replace('<html lang="it">', '<html lang="it" class="web">')
    (OUT / "index.html").write_text(html, encoding="utf-8")
    (OUT / "formats.json").write_text(json.dumps(web_registry(), ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "manifest.webmanifest").write_text(json.dumps(MANIFEST, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "sw.js").write_text(SW.replace("__VERSION__", VERSION), encoding="utf-8")
    icons(OUT / "img")
    (OUT / ".nojekyll").write_text("", encoding="utf-8")
    n = len({e for c in json.loads((OUT / "formats.json").read_text(encoding="utf-8"))["categories"] for e in c["exts"]})
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    big = [p for p in OUT.rglob("*") if p.is_file() and p.stat().st_size > 50 * 1024 * 1024]
    # copia incrementale: in docs/ (su OneDrive) si scrivono solo i file cambiati
    sys.path.insert(0, str(ROOT / "tools"))
    from synctree import sync_tree
    st = sync_tree(OUT, FINAL)
    print(f"web app in {FINAL}: {n} estensioni, {size / 1048576:.0f} MB, file oltre 50 MB: {len(big)} · {st}")


if __name__ == "__main__":
    main()
