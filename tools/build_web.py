"""Web app installabile (PWA) di MB Desk per i cellulari.

Uso:  python tools/build_web.py --mobile   app completa, protetta da licenza, in %USERPROFILE%/.mbvisual/server/public
                                          (poi `wrangler deploy` dalla copia di lavoro del server: vedi CLAUDE.md, Licenze)
      python tools/build_web.py            docs/ (GitHub Pages) = solo un rimando all'app sul server delle licenze: il service
                                          worker toglie la vecchia app salvata nei telefoni e li porta all'indirizzo nuovo
- usa la stessa interfaccia di ui/ con il motore nel browser (ui/js/webapi.js) al posto di quello Python
- elenco formati ridotto a quelli che si aprono davvero nel browser (docs/formats.json)
- manifest, service worker (uso offline, "Condividi > MB Desk" sul telefono), icone
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
# --mobile: versione per cellulari con licenza, nella copia di lavoro del server (FUORI da OneDrive e dal repository)
MOBILE = "--mobile" in sys.argv
if MOBILE:
    FINAL = Path.home() / ".mbvisual" / "server" / "public"
# si costruisce fuori da OneDrive (che blocca i file durante la sincronizzazione) e poi si allinea docs/ con robocopy
OUT = Path.home() / ".mbvisual" / "webbuild"
CACHE = Path.home() / ".mbvisual" / "webvendor"
# versione del service worker: cambia a ogni build, cosi' i telefoni scaricano davvero i file nuovi (cache per versione)
import time as _time
# MBV_VERSIONE = versione dell'app per PC (tools/publish_web.py): l'app per telefono la mostra e la usa come nome della versione
import os as _os
import re as _re
APP_VERSION = _os.environ.get("MBV_VERSIONE") or _re.search(r'^VERSION = "([^"]+)"', (Path(__file__).resolve().parent.parent / "app.py").read_text(encoding="utf-8"), _re.M).group(1)
VERSION = APP_VERSION + "-" + _time.strftime("%Y.%m.%d-%H%M%S")

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
    # scansione documenti (ui/js/scanner.js): OpenCV.js Apache 2.0, Tesseract.js Apache 2.0, dati "ita" di tessdata Apache 2.0
    ("opencv", "https://registry.npmjs.org/@techstark/opencv-js/-/opencv-js-4.10.0-release.1.tgz", {"package/dist/opencv.js": "opencv.js", "package/LICENSE": "LICENSE"}),
    ("tesseract", "https://registry.npmjs.org/tesseract.js/-/tesseract.js-6.0.1.tgz",
     {"package/dist/tesseract.min.js": "tesseract.min.js", "package/dist/worker.min.js": "worker.min.js", "package/LICENSE.md": "LICENSE.md"}),
    ("tesseract", "https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-6.0.0.tgz",
     {"package/tesseract-core-lstm.wasm.js": "tesseract-core-lstm.wasm.js", "package/tesseract-core-simd-lstm.wasm.js": "tesseract-core-simd-lstm.wasm.js"}),
    ("tesseract", "https://registry.npmjs.org/@tesseract.js-data/ita/-/ita-1.0.0.tgz", {"package/4.0.0_best_int/ita.traineddata.gz": "ita.traineddata.gz"}),
    # biglietti da visita (ui/js/bcard.js): dati "eng" di tessdata Apache 2.0, jsQR Apache 2.0 (QR con vCard/MECARD)
    ("tesseract", "https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-1.0.0.tgz", {"package/4.0.0_best_int/eng.traineddata.gz": "eng.traineddata.gz"}),
    ("jsqr", "https://registry.npmjs.org/jsqr/-/jsqr-1.4.0.tgz", {"package/dist/jsQR.js": "jsQR.js", "package/LICENSE": "LICENSE"}),
]

# estensioni che la web app apre davvero (per categoria del registro); le categorie assenti non sono disponibili
WEB_EXTS = {
    "pdf": "*", "signed": "*", "word": "*", "sheet": "*", "pptx": "*", "text": "*", "markdown": "*", "svg": "*",
    "html": ["html", "htm", "xhtml", "shtml"],
    "image": ["png", "apng", "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "gif", "webp", "bmp", "dib", "ico", "cur", "avif", "avifs",
              "tif", "tiff", "heic", "heif", "hif", "heics", "heifs", "psd", "ora"],
    "media": ["mp4", "m4v", "mov", "webm", "ogv", "3gp", "mkv"],
    "audio": ["mp3", "wav", "wave", "flac", "ogg", "oga", "opus", "m4a", "aac"],
    "cad2d": ["dwg", "dxf", "dwt"], "cad3d": "*", "mesh3d": "*", "bcf": "*",
    "archive": ["zip", "zipx", "7z", "rar", "tar", "ova", "gz", "gzip", "tgz", "tpz", "bz2", "bzip2", "tbz", "tbz2", "xz", "txz", "lzma", "z", "taz",
                "cab", "lzh", "lha", "cpio", "rpm", "deb", "ar", "a", "iso", "xar", "pkg", "xip", "jar", "war", "ear", "apk", "aab", "xapk", "ipa",
                "appx", "msix", "appxbundle", "nupkg", "vsix", "xpi", "whl", "egg", "cbz", "cbr", "cb7"],
    "email": ["eml", "mbox", "mbx"], "ebook": "*", "font": ["ttf", "otf", "woff", "woff2"], "database": "*", "gis": "*",
    # visualizzatori che funzionano anche senza il motore Python (22/10/2026)
    "dwf": "*", "calendar": "*", "contacts": "*", "hpgl": "*", "vis3d": "*",
    "visio": ["vsdx", "vsdm", "vstx", "vstm"],          # i .vsd binari richiedono il motore
    "publisher": ["mbpub"],                              # i .pub di Publisher richiedono il motore
    "pointcloud": ["las", "pts", "xyz"],                 # LAZ/E57/PTX richiedono il motore
}
WEB_NOTES = {
    "media": "Riproduzione dei formati supportati dal browser del dispositivo (la conversione di altri formati e' nella versione per PC)",
    "audio": "Riproduzione con forma d'onda dei formati supportati dal browser del dispositivo",
    "image": "Editor in stile Photoshop: livelli, maschere, regolazioni, filtri, pennelli, testo e forme; salvataggio in PSD e ORA con i livelli o in PNG, JPG, WEBP, TIFF",
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


# iPad e iPhone (Safari > Condividi > Aggiungi alla schermata Home): icone senza trasparenza e schermate di avvio per ogni
# misura di schermo (punti CSS x densita'), verticali e orizzontali. STESSO elenco in server/src/index.js (SPLASH): le pagine
# di attivazione, da cui spesso si installa l'app, devono dichiarare le stesse immagini.
SPLASH = [
    (1032, 1376, 2), (1024, 1366, 2), (834, 1210, 2), (834, 1194, 2), (820, 1180, 2), (834, 1112, 2), (810, 1080, 2),
    (768, 1024, 2), (744, 1133, 2),                                                   # iPad (13", 12,9", 11", 10,9", 10,5", 10,2", 9,7", mini)
    (440, 956, 3), (430, 932, 3), (402, 874, 3), (393, 852, 3), (390, 844, 3), (428, 926, 3), (414, 896, 2), (375, 812, 3), (375, 667, 2),  # iPhone
]


def splash_name(w: int, h: int, r: int, land: bool) -> str:
    return f"img/splash-{h * r}x{w * r}.png" if land else f"img/splash-{w * r}x{h * r}.png"


def splash_tags() -> str:
    out = []
    for w, h, r in SPLASH:
        for land in (False, True):
            o = "landscape" if land else "portrait"
            out.append(f'<link rel="apple-touch-startup-image" media="(device-width: {w}px) and (device-height: {h}px) and '
                       f'(-webkit-device-pixel-ratio: {r}) and (orientation: {o})" href="{splash_name(w, h, r, land)}">')
    return "\n".join(out) + "\n"


HEAD = """<meta name="theme-color" content="#0f1114">
<meta name="description" content="MB Desk - visualizzatore di documenti, disegni CAD, modelli 3D e BIM di MB Engineering">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="img/apple-touch-icon-180.png">
<link rel="apple-touch-icon" sizes="152x152" href="img/apple-touch-icon-152.png">
<link rel="apple-touch-icon" sizes="167x167" href="img/apple-touch-icon-167.png">
<link rel="apple-touch-icon" sizes="180x180" href="img/apple-touch-icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="MB Desk">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
__SPLASH__<script>window.MBV_WEB = true; window.MBV_BUILD = "__VERSION__"; window.MBV_VERSION = "__APPVER__"; window.MBV_ROOT = new URL(".", location.href).href;
// ricarica con la versione nuova: la memoria dei file dell'app (cache del service worker) si svuota prima, altrimenti
// l'app potrebbe ripartire con i file vecchi (succedeva sugli iPhone, dove il service worker nuovo spesso non subentra)
window.MBV_HARD_RELOAD = async () => {
  try { for (const k of await caches.keys()) if (k.startsWith("mbv-") && k !== "mbv-condivisi") await caches.delete(k); } catch (e) {}
  window.__mbvReload = true; location.reload();
};
// controllo della versione indipendente dal service worker: version.json (mai dalla cache) all'apertura, al ritorno in
// primo piano, con la rete e ogni 30 minuti; versione diversa = ricarica (con file modificati non salvati si chiede prima)
(function () {
  let busy = false;
  const check = async () => {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      const j = await (await fetch("version.json?t=" + Date.now(), { cache: "no-store" })).json();
      if (j.v && j.v !== "__VERSION__") {
        navigator.serviceWorker?.getRegistration().then(r => r && r.update()).catch(() => {});
        let last = 0; try { last = +sessionStorage.getItem("mbv-ricarica") || 0; } catch (e) {}
        if (Date.now() - last < 60000) return; // una sola ricarica al minuto: niente cicli se qualcosa va storto
        try { sessionStorage.setItem("mbv-ricarica", String(Date.now())); } catch (e) {}
        if ((window.MB?.tabs || []).some(t => t.dirty)) { window.MBV_UPDATE_READY = true; dispatchEvent(new Event("mbv-update")); }
        else window.MBV_HARD_RELOAD();
      }
    } catch (e) { /* senza rete o pagina di attivazione */ } finally { busy = false; }
  };
  addEventListener("load", () => setTimeout(check, 1500));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  addEventListener("pageshow", e => { if (e.persisted) check(); });
  addEventListener("online", check);
  setInterval(check, 30 * 60000);
})();
// guardia d'avvio: se l'app non e' pronta dopo 15 s (richiesta rimasta appesa, file vecchi del service worker, errore) la
// prima volta si svuotano cache e service worker e si ricarica da soli; se non basta si mostra il motivo con "Riprova"
// al posto di una pagina vuota. Testi qui dentro: i18n.js puo' essere proprio la parte che non parte.
(function () {
  const errs = [];
  addEventListener("error", e => errs.push(String(e.message || (e.target && (e.target.src || e.target.href)) || "error")), true);
  addEventListener("unhandledrejection", e => errs.push(String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
  window.MBV_BOOT_ERRS = errs;
  const L = { it: ["MB Desk non si e' avviata.", "Riprova", "Controlla la connessione a internet e riprova."],
    en: ["MB Desk did not start.", "Try again", "Check your internet connection and try again."],
    es: ["MB Desk no se ha iniciado.", "Reintentar", "Comprueba la conexion a internet y vuelve a intentarlo."],
    fr: ["MB Desk n'a pas demarre.", "Reessayer", "Verifiez la connexion internet et reessayez."],
    de: ["MB Desk wurde nicht gestartet.", "Erneut versuchen", "Pruefen Sie die Internetverbindung und versuchen Sie es erneut."] };
  let lang = "it"; try { lang = (localStorage.getItem("mbv-lang") || navigator.language || "it").slice(0, 2); } catch (e) {}
  const T = L[lang] || L.en;
  const clean = async () => {
    try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch (e) {}
    try { for (const k of await caches.keys()) if (k.startsWith("mbv-") && k !== "mbv-condivisi") await caches.delete(k); } catch (e) {}
    window.__mbvReload = true; location.reload();
  };
  const ss = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} };
  setTimeout(() => {
    if (window.MBV_READY) return ss("mbv-avvio", null);
    if (!ss("mbv-avvio") && navigator.onLine !== false) { ss("mbv-avvio", "1"); return clean(); }
    const box = document.createElement("div");
    box.id = "mbv-avvio";
    box.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#17191b;color:#e6e8e5;font:15px system-ui,sans-serif;text-align:center;cursor:default";
    box.innerHTML = '<div style="max-width:440px"><img src="img/logo-512.png" alt="" style="width:96px;height:96px"><h2 style="font-size:20px;margin:12px 0 6px"></h2><p style="color:#9ea29b"></p>'
      + '<button style="margin-top:12px;width:100%;padding:12px;border:0;border-radius:8px;background:#f07d2e;color:#16110c;font:600 16px system-ui;cursor:default"></button>'
      + '<pre style="margin-top:16px;text-align:left;white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,monospace;color:#8a8c89;max-height:30vh;overflow:auto"></pre></div>';
    box.querySelector("h2").textContent = T[0];
    box.querySelector("p").textContent = T[2];
    box.querySelector("button").textContent = T[1];
    box.querySelector("button").onclick = clean;
    const NL = String.fromCharCode(10);
    box.querySelector("pre").textContent = (window.MBV_BUILD || "") + " · " + navigator.userAgent + (errs.length ? NL + NL + errs.slice(-6).join(NL) : "");
    document.documentElement.classList.add("ph-ready");
    document.body.appendChild(box);
    const wait = setInterval(() => { if (window.MBV_READY) { clearInterval(wait); box.remove(); ss("mbv-avvio", null); } }, 1000);
  }, 15000);
})();
if ("serviceWorker" in navigator) {
  // aggiornamento automatico insieme all'app per PC (tools/publish_web.py): controllo all'apertura, ogni 30 minuti,
  // quando l'app torna in primo piano e quando torna la rete
  // registrazione qualche secondo DOPO l'avvio: su iPhone/iPad, se il service worker si installa mentre l'app carica
  // formats.json, lingue e moduli, Safari lascia appese le richieste della pagina (schermo bianco alla prima apertura)
  addEventListener("load", () => setTimeout(() => navigator.serviceWorker.register("sw.js").then(reg => {
    const check = () => reg.update().catch(() => {});
    setInterval(check, 30 * 60000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
    addEventListener("online", check);
  }).catch(() => {}), 6000));
  // versione nuova installata: si ricarica per usare i file nuovi (non alla prima installazione); con file modificati
  // non salvati si aspetta: l'app mostra "Aggiornamento pronto" con il pulsante per ricaricare (ui/js/phone.js)
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!had || window.__mbvReload) return;
    if ((window.MB?.tabs || []).some(t => t.dirty)) { window.MBV_UPDATE_READY = true; dispatchEvent(new Event("mbv-update")); return; }
    window.__mbvReload = true; location.reload();
  });
}</script>
"""

MANIFEST = {
    "name": "MB Desk", "short_name": "MB Desk", "id": "./", "start_url": "./", "scope": "./", "display": "standalone",
    "orientation": "any", "background_color": "#0f1114", "theme_color": "#0f1114", "lang": "it",
    "description": "Powered by MB Group",
    "icons": [{"src": "img/icon-192.png", "sizes": "192x192", "type": "image/png"},
              {"src": "img/icon-512.png", "sizes": "512x512", "type": "image/png"},
              {"src": "img/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
              {"src": "img/apple-touch-icon-180.png", "sizes": "180x180", "type": "image/png"}],
    "share_target": {"action": "./condividi", "method": "POST", "enctype": "multipart/form-data",
                     "params": {"files": [{"name": "file", "accept": ["*/*"]}]}},
}

SW = r"""// Service worker di MB Desk: uso offline (cache) e ricezione dei file condivisi da altre app
const VERSION = "__VERSION__";
const CORE = ["./", "index.html", "css/app.css", "css/phone.css", "js/app.js", "js/core.js", "js/webapi.js", "js/phone.js", "js/phonestore.js", "formats.json", "img/logo.png", "img/logo-512.png", "img/icon-192.png", "manifest.webmanifest"];
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
  if (url.pathname.endsWith("/version.json")) return; // controllo della versione: sempre dalla rete
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
    # iPad/iPhone: icona quadrata piena (iOS arrotonda da se' gli angoli; le parti trasparenti diventerebbero nere)
    full = Image.new("RGBA", (512, 512), (138, 140, 137, 255))
    full.alpha_composite(logo)
    for s in (152, 167, 180):
        full.convert("RGB").resize((s, s), Image.LANCZOS).save(img_dir / f"apple-touch-icon-{s}.png", optimize=True)
    # schermate di avvio: fondo grafite della cornice dell'app e logo al centro
    for w, h, r in SPLASH:
        for land in (False, True):
            W, H = (h * r, w * r) if land else (w * r, h * r)
            im = Image.new("RGB", (W, H), (15, 17, 20))
            side = int(min(W, H) * 0.26)
            lg = logo.resize((side, side), Image.LANCZOS)
            im.paste(lg, ((W - side) // 2, (H - side) // 2), lg)
            im.save(img_dir / splash_name(w, h, r, land).split("/")[1], optimize=True)


REDIRECT_HTML = """<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MB Desk</title><meta http-equiv="refresh" content="0; url=__URL__/">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17191b;color:#e6e8e5;font:15px system-ui,sans-serif;text-align:center;padding:20px}a{color:#f07d2e}</style>
<script>
// la web app si e' spostata sul server delle licenze: via la vecchia app salvata (service worker e cache), poi l'indirizzo nuovo
(async () => {
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch (e) {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch (e) {}
  location.replace("__URL__/");
})();
</script></head><body><p>MB Desk si e' spostata a un nuovo indirizzo.<br><a href="__URL__/">__URL__</a></p></body></html>
"""

REDIRECT_SW = r"""// La web app si e' spostata sul server delle licenze: questo service worker sostituisce quello vecchio,
// cancella la copia salvata e porta le finestre aperte all'indirizzo nuovo.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate("__URL__/");
})()));
"""


def redirect_docs() -> None:
    """docs/ (GitHub Pages) = rimando all'app per cellulari sul server delle licenze."""
    sys.path.insert(0, str(ROOT))
    from mbvisual import license_pub
    url = (license_pub.LICENSE_URL or "").rstrip("/")
    if not url:
        raise SystemExit("LICENSE_URL vuoto in mbvisual/license_pub.py: niente rimando")
    out = OUT.parent / "webbuild-rimando"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    (out / "index.html").write_bytes(REDIRECT_HTML.replace("__URL__", url).encode("utf-8"))
    (out / "sw.js").write_bytes(REDIRECT_SW.replace("__URL__", url).encode("utf-8"))
    (out / ".nojekyll").write_bytes(b"")
    sys.path.insert(0, str(ROOT / "tools"))
    from synctree import sync_tree
    print(f"docs/ = rimando a {url}:", sync_tree(out, FINAL))


def main() -> None:
    global OUT
    if not MOBILE:
        return redirect_docs()
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
    html = html.replace('<link rel="icon" href="img/logo.png">', '<link rel="icon" href="img/logo.png">\n' + HEAD.replace("__SPLASH__", splash_tags()).replace("__VERSION__", VERSION).replace("__APPVER__", APP_VERSION))
    html = html.replace('"/vendor/', '"./vendor/')
    html = html.replace('<script type="module" src="js/app.js"></script>', '<script type="module" src="js/webapi.js"></script>\n<script type="module" src="js/app.js"></script>')
    html = html.replace('<html lang="it">', '<html lang="it" class="web">')
    if MOBILE:
        # app per cellulari servita dal server delle licenze: controllo della licenza e menu Account
        html = html.replace("window.MBV_WEB = true;", "window.MBV_WEB = true; window.MBV_MOBILE = true;")
        html = html.replace('<script type="module" src="js/webapi.js"></script>', '<script type="module" src="js/mlicenza.js"></script>\n<script type="module" src="js/webapi.js"></script>')
        # dicitura chiesta dall'utente sotto il logo (marchio: non si traduce; div e non p: app.js riscrive il primo p della home)
        h1 = '<h1 data-i18n="idx.trascina_qui_i_file_aprire">'
        assert h1 in html
        html = html.replace(h1, '<div style="margin:0 0 6px;color:var(--brand);font:600 12px var(--mono);letter-spacing:.14em;text-transform:uppercase">Powered by MB Group</div>\n            ' + h1)
    (OUT / "index.html").write_text(html, encoding="utf-8")
    (OUT / "formats.json").write_text(json.dumps(web_registry(), ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "manifest.webmanifest").write_text(json.dumps(MANIFEST, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "sw.js").write_text(SW.replace("__VERSION__", VERSION).replace("__APPVER__", APP_VERSION), encoding="utf-8")
    (OUT / "version.json").write_text(json.dumps({"v": VERSION, "app": APP_VERSION}), encoding="utf-8")  # controllo della versione (index.html)
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
