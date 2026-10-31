"""Un campione per ogni estensione del registro (ui/formats.json), per il collaudo nell'app vera (tests/test_all_formats.mjs).

    python tools/make_format_samples.py <cartella> [--no-download] [--only ext,ext] [--extra <cartella>]... [--riusa <cartella precedente>]

Ordine delle fonti per ogni coppia (categoria, estensione):
1. file generati qui (Pillow, FFmpeg, 7-Zip, Office via COM se installato, ezdxf, trimesh/numpy, testo...);
2. campioni del repository (tests/samples);
3. file pubblici scaricati in <cartella>/_scaricati (fate-suite di FFmpeg, immagini di prova di Pillow, moduli di prova di
   libxmp/OpenMPT, raw.pixls.us...): solo per le prove, mai nel repository; elenco delle fonti in <cartella>/FONTI.md;
4. cartelle in piu' con --extra (per esempio i campioni scaricati da altre sessioni in %USERPROFILE%\\.mbvisual).
Scrive <cartella>/manifest.json = { items: [{ ext, cat, file, fonte }], senza: [{ ext, cat, motivo }] }.
Un'estensione senza campione NON e' collaudata: il resoconto la elenca a parte.
"""
import gzip
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from mbvisual.paths import find_7zip, find_ffmpeg  # noqa: E402

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
REG = json.loads((ROOT / "ui" / "formats.json").read_text(encoding="utf-8"))
CATS = {c["id"]: c for c in REG["categories"]}
SAMPLES = ROOT / "tests" / "samples"
args = sys.argv[1:]
if not args or args[0].startswith("--"):
    sys.exit(__doc__)
OUT = Path(args[0]).resolve()
CACHE = OUT / "_scaricati"
DOWNLOAD = "--no-download" not in args
ONLY = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
EXTRA = [Path(args[i + 1]) for i, a in enumerate(args) if a == "--extra"]
REUSE = Path(args[args.index("--riusa") + 1]) if "--riusa" in args else None  # cartella di un giro precedente: si riprendono i file fatti da Office
FF = find_ffmpeg()
SZ = find_7zip()
items, missing, sources = [], [], set()
done = set()


def reachable(cat, ext):
    """le estensioni anche GIS vanno sempre alla mappa (app.js resolveCategory), salvo tif/tiff/zip che decide il contenuto."""
    return cat == "gis" or ext not in CATS["gis"]["exts"] or ext in ("tif", "tiff", "zip")


def want(cat, ext):
    return ext in CATS[cat]["exts"] and reachable(cat, ext) and (cat, ext) not in done and (not ONLY or ext in ONLY)


def dest(cat, ext, name=None):
    d = OUT / cat / ext.replace("+", "plus")
    d.mkdir(parents=True, exist_ok=True)
    return d / (name or f"campione.{ext}")


def put(cat, ext, data, fonte, name=None):
    """data = bytes, str o Path da copiare. Restituisce il percorso scritto."""
    if not want(cat, ext):
        return None
    p = dest(cat, ext, name)
    if isinstance(data, Path):
        shutil.copyfile(data, p)
    elif isinstance(data, str):
        p.write_text(data, encoding="utf-8", newline="\n")
    else:
        p.write_bytes(data)
    done.add((cat, ext))
    items.append({"ext": ext, "cat": cat, "file": str(p.relative_to(OUT)), "fonte": fonte})
    return p


def side(cat, ext, name, data):
    """file accanto al campione (es. .dbf/.shx dello shapefile)."""
    p = dest(cat, ext, name)
    if isinstance(data, Path):
        shutil.copyfile(data, p)
    else:
        p.write_bytes(data)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW, **kw)


def dl(url, name=None):
    """file pubblico in cache; None se lo scaricamento non riesce o e' spento."""
    name = name or url.rsplit("/", 1)[-1].split("?")[0]
    p = CACHE / name
    if p.exists() and p.stat().st_size:
        sources.add(url)
        return p
    if not DOWNLOAD:
        return None
    CACHE.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "MB-Desk-collaudo"})
        p.write_bytes(urllib.request.urlopen(req, timeout=120).read())
        sources.add(url)
        return p
    except Exception as e:  # noqa: BLE001
        print("  scaricamento non riuscito:", url, e)
        return None


def tmp(name):
    d = OUT / "_lavoro"
    d.mkdir(parents=True, exist_ok=True)
    return d / name


# ============================================================ testo, markdown, html, svg
TEXT_BODY = {
    "json": '{\n  "progetto": "Campione",\n  "valori": [1, 2, 3]\n}\n', "jsonc": '// commento\n{ "a": 1 }\n', "json5": "{ a: 1, // commento\n b: 'x' }\n",
    "ndjson": '{"a":1}\n{"a":2}\n', "jsonl": '{"a":1}\n{"a":2}\n', "har": '{"log":{"version":"1.2","entries":[]}}\n',
    "ipynb": json.dumps({"cells": [{"cell_type": "code", "metadata": {}, "source": ["print(1)"], "outputs": [], "execution_count": None}],
                         "metadata": {}, "nbformat": 4, "nbformat_minor": 5}),
    "yaml": "progetto: campione\nvalori:\n  - 1\n  - 2\n", "yml": "a: 1\n", "toml": '[progetto]\nnome = "campione"\n',
    "ini": "[sezione]\nchiave=valore\n", "csv": "a;b\n1;2\n", "srt": "1\n00:00:01,000 --> 00:00:02,000\nCiao\n",
    "vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nCiao\n", "ldif": "dn: cn=prova,dc=esempio,dc=it\ncn: prova\n",
    "m3u": "#EXTM3U\n#EXTINF:2,Tono\ntono.wav\n", "m3u8": "#EXTM3U\n#EXT-X-VERSION:3\n", "pls": "[playlist]\nFile1=tono.wav\nNumberOfEntries=1\n",
    "xspf": '<?xml version="1.0"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/"><trackList/></playlist>\n',
    "gcode": "G21\nG90\nG1 X10 Y10 F1000\n", "nc": "%\nO1000\nG21 G90\nG1 X10 Y10 F500\nM30\n%\n", "ngc": "G0 X0 Y0\n", "tap": "G0 X0 Y0\n",
    "cnc": "G0 X0 Y0\n", "iso": "%\nN10 G0 X0 Y0\n%\n", "mpf": "G0 X0 Y0\nM30\n", "spf": "G0 X0\nRET\n",
    "lsp": '(defun c:ciao () (princ "ciao"))\n', "scr": "LINE 0,0 10,10 \n", "dcl": 'ciao : dialog { label = "Ciao"; ok_only; }\n',
    "pat": "*PROVA, Linee a 45 gradi\n45, 0,0, 0,3.175\n", "lin": "*TRATTEGGIO,__ __ __\nA,6.35,-3.175\n",
    "shx": "*0,4,PROVA\n2,8,(0,0),0\n", "las": "~VERSION INFORMATION\n VERS. 2.0 : CWLS LOG ASCII STANDARD\n~WELL\n~CURVE\n~A\n",
    "asc": "-----BEGIN PGP MESSAGE-----\n\nhQEMA\n-----END PGP MESSAGE-----\n", "dat": "1 2 3\n4 5 6\n",
    "patch": "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-a\n+b\n", "diff": "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-a\n+b\n",
    "mod": "module esempio.it/prova\n\ngo 1.22\n", "sum": "esempio.it/x v1.0.0 h1:abc=\n", "lock": "# lock\n",
    "key": "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n",
    "pub": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIProva prova@pc\n", "sig": "-----BEGIN PGP SIGNATURE-----\n\niQ\n-----END PGP SIGNATURE-----\n",
    "reg": "Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\Software\\Prova]\n\"a\"=\"b\"\n",
    "ram": "http://www.esempio.it/audio/brano.ra\nrtsp://www.esempio.it/audio/brano2.ra\n",  # metafile RealAudio: elenco di indirizzi
    "desktop": "[Desktop Entry]\nName=Prova\nExec=prova\n", "service": "[Unit]\nDescription=Prova\n",
}
XMLISH = {"xml", "xsd", "xsl", "xslt", "rss", "atom", "plist", "resx", "xaml", "gml", "csproj", "vbproj", "vcxproj", "props", "targets",
          "nuspec", "manifest", "wxi", "wxl", "wxs", "opf", "dtd"}


def text_sample(ext):
    if ext in TEXT_BODY:
        return TEXT_BODY[ext]
    if ext in XMLISH:
        return '<?xml version="1.0" encoding="UTF-8"?>\n<radice>\n  <voce nome="campione">valore</voce>\n</radice>\n'
    return f"// campione .{ext} per il collaudo dei formati\nriga 1: testo con accenti à è ì ò ù\nriga 2: valore = 42\n"


def gen_text():
    gis = set(CATS["gis"]["exts"])
    for ext in CATS["text"]["exts"]:
        if ext in gis:  # GeoJSON/KML/GPX/TopoJSON vanno sempre alla mappa (app.js resolveCategory)
            continue
        put("text", ext, text_sample(ext), "generato")
    md = "# Campione\n\nTesto **in grassetto** e un elenco:\n\n- uno\n- due\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    for ext in CATS["markdown"]["exts"]:
        put("markdown", ext, md, "generato")
    html = "<!doctype html><html><head><meta charset='utf-8'><title>Campione</title></head><body><h1>Campione</h1><p>Testo à è.</p></body></html>\n"
    for ext in ("html", "htm", "shtml"):
        put("html", ext, html, "generato")
    put("html", "xhtml", '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Campione</title></head>'
        "<body><h1>Campione</h1><p>Testo.</p></body></html>\n", "generato")
    mht = ("MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"B\"; type=\"text/html\"\r\n\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\n"
           "Content-Location: file:///c:/campione.htm\r\n\r\n" + html.replace("\n", "\r\n") + "\r\n--B--\r\n")
    put("html", "mht", mht, "generato")
    put("html", "mhtml", mht, "generato")
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect x="10" y="10" width="180" height="100" '
           'fill="#f07d2e" stroke="#333"/><circle cx="100" cy="60" r="30" fill="#fff"/><text x="20" y="110">Campione</text></svg>\n')
    put("svg", "svg", svg, "generato")
    put("html", "svgz", gzip.compress(svg.encode()), "generato")


# ============================================================ immagini
def gen_images():
    from PIL import Image, ImageDraw
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:  # noqa: BLE001
        pass
    im = Image.new("RGB", (160, 120), "white")
    d = ImageDraw.Draw(im)
    d.rectangle((10, 10, 150, 110), outline="black", width=3)
    d.ellipse((40, 20, 120, 100), fill=(240, 125, 46))
    d.text((14, 14), "MB", fill="black")
    rgba = im.convert("RGBA")

    def save(ext, fmt, img=im, **kw):
        if not want("image", ext):
            return
        b = io.BytesIO()
        try:
            img.save(b, fmt, **kw)
        except Exception as e:  # noqa: BLE001
            print("  immagine non generata", ext, fmt, e)
            return
        put("image", ext, b.getvalue(), "generato (Pillow)")

    for ext in ("png",):
        save(ext, "PNG")
    frames = [im, im.rotate(90), im.rotate(180)]
    save("apng", "PNG", save_all=True, append_images=frames[1:], duration=200, loop=0)
    for ext in ("jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp"):
        save(ext, "JPEG", quality=85)
    save("gif", "GIF")
    save("webp", "WEBP")
    for ext in ("bmp", "dib"):
        save(ext, "BMP")
    save("ico", "ICO", img=rgba, sizes=[(32, 32), (64, 64)])
    save("avif", "AVIF")
    for ext in ("tif", "tiff"):
        save(ext, "TIFF")
    for ext in ("tga", "icb", "vda", "vst"):
        save(ext, "TGA")
    save("pcx", "PCX")
    save("ppm", "PPM")
    save("pnm", "PPM")
    save("pgm", "PPM", img=im.convert("L"))
    save("pbm", "PPM", img=im.convert("1"))
    save("pfm", "PFM", img=im.convert("F"))
    for ext in ("sgi", "rgb"):
        save(ext, "SGI")
    save("rgba", "SGI", img=rgba)
    save("bw", "SGI", img=im.convert("L"))
    save("dds", "DDS", img=rgba)
    save("icns", "ICNS", img=rgba.resize((128, 128)))
    for ext in ("jp2", "jpx", "jpf"):
        save(ext, "JPEG2000", no_jp2=False)
    for ext in ("j2k", "j2c", "jpc"):
        save(ext, "JPEG2000", no_jp2=True)
    save("xbm", "XBM", img=im.convert("1"))
    save("im", "IM")
    save("msp", "MSP", img=im.convert("1"))
    save("blp", "BLP", img=im.convert("P"))
    save("qoi", "QOI")
    save("spi", "SPIDER", img=im.convert("F"))
    save("mpo", "MPO", save_all=True, append_images=[im.rotate(5)])
    for ext in ("heic", "heif", "hif"):
        save(ext, "HEIF")
    for ext in ("heics", "heifs"):
        save(ext, "HEIF", save_all=True, append_images=[im.rotate(90)])
    save("avifs", "AVIF", save_all=True, append_images=[im.rotate(90)], duration=200)
    # OpenRaster: zip con stack.xml e immagine unita
    if want("image", "ora"):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            z.writestr(zipfile.ZipInfo("mimetype"), "image/openraster")
            png = io.BytesIO()
            im.save(png, "PNG")
            z.writestr("data/livello.png", png.getvalue())
            z.writestr("mergedimage.png", png.getvalue())
            th = io.BytesIO()
            im.resize((80, 60)).save(th, "PNG")
            z.writestr("Thumbnails/thumbnail.png", th.getvalue())
            z.writestr("stack.xml", '<?xml version="1.0"?><image w="160" h="120" version="0.0.3"><stack><layer name="Livello" src="data/livello.png" x="0" y="0"/></stack></image>')
        put("image", "ora", b.getvalue(), "generato")
    # FITS minimo (8 bit, 2D): intestazione a blocchi di 2880 byte
    if want("image", "fits"):
        g = im.convert("L")
        cards = ["SIMPLE  =                    T", "BITPIX  =                    8", "NAXIS   =                    2",
                 f"NAXIS1  = {g.width:20d}", f"NAXIS2  = {g.height:20d}", "END"]
        head = "".join(c.ljust(80) for c in cards).ljust(2880).encode("ascii")
        data = g.transpose(Image.FLIP_TOP_BOTTOM).tobytes()
        data += b"\0" * (-len(data) % 2880)
        for ext in ("fits", "fit", "fts"):
            put("image", ext, head + data, "generato")
    # XPM e GIMP brush: dai file di prova di Pillow
    PIL_T = "https://raw.githubusercontent.com/python-pillow/Pillow/main/Tests/images/"
    for ext, name in (("xpm", "hopper.xpm"), ("gbr", "gbr.gbr"), ("dcx", "hopper.dcx"), ("emf", "drawing.emf"), ("wmf", "drawing.wmf"),
                      ("fli", "hopper.fli"), ("fpx", "input_bw_one_band.fpx"), ("pxr", "hopper.pxr"), ("ras", "hopper.ras"),
                      ("mic", "hopper.mic"), ("ftc", "ftex_dxt1.ftc"), ("ftu", "ftex_uncompressed.ftu"), ("psd", "hopper.psd"), ("cur", "deerstalker.cur")):
        if want("image", ext):
            p = dl(PIL_T + name, "pillow_" + name)
            if p:
                put("image", ext, p, "Pillow Tests/images/" + name)
    if want("image", "flc"):  # FLC (Autodesk Animator Pro): il 2422.flc delle prove di Pillow e' un caso limite che Pillow rifiuta
        p = dl("https://samples.ffmpeg.org/fli-flc/HWdopple.flc", "ffmpeg_HWdopple.flc")
        if p:
            put("image", "flc", p, "samples.ffmpeg.org fli-flc/HWdopple.flc")


# ============================================================ audio e video (FFmpeg)
A_IN = ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"]
V_IN = ["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25"]
VIDEO = {
    "mp4": [], "m4v": ["-f", "ipod"], "mov": [], "qt": ["-f", "mov"], "webm": ["-c:v", "libvpx", "-b:v", "400k", "-c:a", "libvorbis"],
    "mkv": [], "mk3d": ["-f", "matroska"], "avi": [], "divx": ["-f", "avi", "-c:v", "mpeg4", "-vtag", "DIVX"], "xvid": ["-f", "avi", "-c:v", "mpeg4", "-vtag", "XVID"],
    "wmv": ["-f", "asf", "-c:v", "wmv2", "-c:a", "wmav2"], "asf": ["-c:v", "wmv2", "-c:a", "wmav2"], "dvr-ms": ["-f", "asf", "-c:v", "wmv2", "-c:a", "wmav2"],
    "flv": [], "f4v": ["-f", "f4v"], "swf": ["-c:v", "flv1", "-ar", "44100"], "mpg": ["-f", "mpeg"], "mpeg": ["-f", "mpeg"], "mpe": ["-f", "mpeg"],
    "evo": ["-f", "vob"], "vro": ["-f", "vob"], "mod": ["-f", "vob"], "vob": ["-f", "vob"],
    "m1v": ["-an", "-c:v", "mpeg1video", "-f", "mpeg1video"], "m2v": ["-an", "-c:v", "mpeg2video", "-f", "mpeg2video"],
    "mp2v": ["-an", "-c:v", "mpeg2video", "-f", "mpeg2video"], "mpv": ["-an", "-c:v", "mpeg2video", "-f", "mpeg2video"],
    "ts": [], "mts": ["-f", "mpegts"], "m2ts": ["-f", "mpegts"], "m2t": ["-f", "mpegts"], "tp": ["-f", "mpegts"], "trp": ["-f", "mpegts"], "tod": ["-f", "mpegts"],
    "3gp": ["-c:v", "h263", "-s", "352x288", "-ar", "8000", "-ac", "1", "-c:a", "aac"], "3g2": ["-c:v", "h263", "-s", "352x288", "-ar", "8000", "-ac", "1", "-c:a", "aac"],
    "ogv": ["-f", "ogg", "-c:v", "libtheora", "-c:a", "libvorbis"], "ogm": ["-f", "ogg", "-c:v", "libtheora", "-c:a", "libvorbis"],
    "rm": ["-c:v", "rv20", "-s", "352x288", "-c:a", "ac3"], "rmvb": ["-f", "rm", "-c:v", "rv20", "-s", "352x288", "-c:a", "ac3"],
    "ivr": ["-f", "rm", "-c:v", "rv20", "-s", "352x288", "-c:a", "ac3"],
    "dv": ["-c:v", "dvvideo", "-s", "720x576", "-pix_fmt", "yuv420p", "-r", "25", "-ar", "48000"], "dif": ["-f", "dv", "-c:v", "dvvideo", "-s", "720x576", "-pix_fmt", "yuv420p", "-r", "25", "-ar", "48000"],
    "mxf": ["-c:v", "mpeg2video", "-ar", "48000"], "nut": [], "y4m": ["-an"],
    "h264": ["-an", "-c:v", "libx264", "-f", "h264"], "264": ["-an", "-c:v", "libx264", "-f", "h264"], "avc": ["-an", "-c:v", "libx264", "-f", "h264"],
    "h26l": ["-an", "-c:v", "libx264", "-f", "h264"], "h265": ["-an", "-c:v", "libx265", "-f", "hevc"], "265": ["-an", "-c:v", "libx265", "-f", "hevc"],
    "hevc": ["-an", "-c:v", "libx265", "-f", "hevc"], "h261": ["-an", "-c:v", "h261", "-s", "352x288", "-f", "h261"],
    "ivf": ["-an", "-c:v", "libvpx"], "vp8": ["-an", "-c:v", "libvpx", "-f", "ivf"], "vp9": ["-an", "-c:v", "libvpx-vp9", "-f", "ivf"],
    "av1": ["-an", "-c:v", "libaom-av1", "-cpu-used", "8", "-f", "ivf"], "obu": ["-an", "-c:v", "libaom-av1", "-cpu-used", "8", "-f", "obu"],
    "roq": ["-s", "256x256", "-r", "30", "-ar", "22050"], "gxf": ["-c:v", "mpeg2video", "-s", "720x576", "-r", "25", "-pix_fmt", "yuv420p", "-ar", "48000"],
    "wtv": [], "amv": ["-c:v", "amv", "-s", "160x120", "-r", "25", "-pix_fmt", "yuvj420p", "-c:a", "adpcm_ima_amv", "-ar", "22050", "-ac", "1", "-block_size", "882"],
    "yuv": ["-an", "-f", "rawvideo", "-pix_fmt", "yuv420p"], "mjpeg": ["-an", "-c:v", "mjpeg", "-f", "mjpeg"], "mjpg": ["-an", "-c:v", "mjpeg", "-f", "mjpeg"],
    "drc": ["-an", "-c:v", "vc2", "-f", "dirac", "-strict", "-2"], "gifv": ["-f", "mp4", "-an"], "mj2": ["-an", "-c:v", "jpeg2000", "-f", "mj2"],
    "ism": ["-f", "ismv"], "isma": ["-f", "ismv", "-vn"], "ismv": ["-f", "ismv"],
}
AUDIO = {
    "mp3": [], "wav": [], "wave": ["-f", "wav"], "bwf": ["-f", "wav", "-write_bext", "1"], "flac": [], "ogg": ["-c:a", "libvorbis"], "oga": ["-f", "ogg", "-c:a", "libvorbis"],
    "opus": ["-c:a", "libopus"], "m4a": [], "m4b": ["-f", "ipod"], "m4r": ["-f", "ipod"], "aac": [], "adts": ["-f", "adts"],
    "wma": ["-f", "asf", "-c:a", "wmav2"], "aif": ["-f", "aiff"], "aiff": [], "aifc": ["-f", "aiff", "-c:a", "pcm_s16be"], "caf": [], "wv": [], "tta": [],
    "mka": [], "ac3": [], "eac3": [], "ec3": ["-f", "eac3"], "dts": ["-c:a", "dca", "-strict", "-2", "-ar", "48000"],
    "mlp": ["-ar", "48000", "-strict", "-2"], "truehd": ["-ar", "48000", "-strict", "-2"], "thd": ["-f", "truehd", "-ar", "48000", "-strict", "-2"],
    "amr": ["-c:a", "libopencore_amrnb", "-ar", "8000", "-ac", "1"], "3ga": ["-f", "3gp", "-c:a", "libopencore_amrnb", "-ar", "8000", "-ac", "1"],
    "gsm": ["-ar", "8000", "-ac", "1"], "au": [], "snd": ["-f", "au"], "voc": [], "w64": [], "rf64": ["-f", "wav", "-rf64", "always"],
    "spx": ["-c:a", "libspeex", "-ar", "16000"], "ra": ["-f", "rm", "-c:a", "ac3"], "sln": ["-f", "s16le", "-ar", "8000", "-ac", "1"],
    "pcm": ["-f", "s16le", "-ac", "2"], "s16le": ["-f", "s16le", "-ac", "2"], "alaw": ["-f", "alaw", "-ar", "8000", "-ac", "1"], "ulaw": ["-f", "mulaw", "-ar", "8000", "-ac", "1"],
    "al": ["-f", "alaw", "-ar", "8000", "-ac", "1"], "ul": ["-f", "mulaw", "-ar", "8000", "-ac", "1"], "adx": ["-c:a", "adpcm_adx"],
    "sph": ["-f", "wav"] if False else None, "ircam": ["-f", "au"] if False else None,
    "g722": ["-ar", "16000", "-ac", "1"], "722": ["-f", "g722", "-ar", "16000", "-ac", "1"], "sbc": ["-ar", "44100"], "msbc": ["-c:a", "sbc", "-msbc", "1", "-ar", "16000", "-ac", "1", "-f", "sbc"],
    "aptx": ["-ar", "48000", "-ac", "2"], "aptxhd": ["-ar", "48000", "-ac", "2"], "dfpwm": ["-ar", "48000", "-ac", "1"],
    "mp2": [], "mpa": ["-f", "mp2"], "m2a": ["-f", "mp2"], "ast": ["-c:a", "pcm_s16be_planar"], "rso": ["-ar", "8000", "-ac", "1", "-c:a", "pcm_u8"],
    "sox": None, "ub": ["-f", "u8", "-ar", "8000", "-ac", "1"], "sw": ["-f", "s16le", "-ar", "8000", "-ac", "1"], "uw": ["-f", "u16le", "-ar", "8000", "-ac", "1"], "sf": ["-f", "s16le"] if False else None,
    "302": ["-f", "s302m", "-c:a", "s302m", "-ar", "48000", "-strict", "-2"] if False else None, "lc3": ["-c:a", "liblc3"],
    "iff": ["-f", "iff"] if False else None, "c2": ["-c:a", "codec2", "-ar", "8000", "-ac", "1", "-f", "codec2"],
    "apm": None, "wsd": None,
}


def ffgen(cat, ext, extra, video):
    if extra is None or not want(cat, ext):
        return
    out = tmp(f"ff.{ext}")
    cmd = [FF, "-y", "-loglevel", "error", *(V_IN if video else []), *A_IN, *extra]
    if not video:
        cmd += ["-vn"]
    cmd.append(str(out))
    r = run(cmd)
    if r.returncode == 0 and out.exists() and out.stat().st_size:
        put(cat, ext, out, "generato (FFmpeg)")
    else:
        print(f"  FFmpeg non genera .{ext}: {r.stderr.decode('utf-8', 'replace').strip()[-160:]}")


def gen_media():
    for ext, extra in VIDEO.items():
        ffgen("media", ext, extra, True)
    for ext, extra in AUDIO.items():
        ffgen("audio", ext, extra, False)
    gen_midi()


def _vlq(n):
    out = [n & 0x7F]
    while n > 127:
        n >>= 7
        out.insert(0, (n & 0x7F) | 0x80)
    return bytes(out)


def gen_midi():
    """MIDI: preludio BWV 846 dal Mutopia Project (pubblico dominio) o, senza rete, quattro note scritte qui; .kar = lo stesso
    brano con una traccia di testo karaoke (eventi di testo, "/" a capo, "\\" paragrafo, intestazione @KMIDI); .rmi = RIFF RMID."""
    f = dl("https://www.mutopiaproject.org/ftp/BachJS/BWV846/wtk1-prelude1/wtk1-prelude1.mid", "mutopia_wtk1-prelude1.mid")
    if f:
        mid, fonte = f.read_bytes(), "Mutopia Project BWV 846 (pubblico dominio)"
    else:
        ev = b""
        for n in (60, 64, 67, 72):
            ev += b"\x00\x90" + bytes([n]) + b"\x60" + b"\x60\x80" + bytes([n]) + b"\x40"
        ev += b"\x00\xff\x2f\x00"
        mid, fonte = b"MThd" + struct.pack(">IHHH", 6, 0, 1, 96) + b"MTrk" + struct.pack(">I", len(ev)) + ev, "generato"
    for ext in ("mid", "midi"):
        put("midi", ext, mid, fonte)
    fmt, ntr, div = struct.unpack(">HHH", mid[8:14])
    words = ["@KMIDI KARAOKE FILE", "@TCampione karaoke", "\\Can", "ta ", "con ", "me", "/la ", "pri", "ma ", "ri", "ga", "\\e ", "poi ", "la ", "se", "con", "da"]
    ev = b""
    for w in words:
        b = w.encode("latin-1")
        ev += _vlq(0 if w.startswith("@") else div // 2) + b"\xff\x01" + _vlq(len(b)) + b
    ev += b"\x00\xff\x2f\x00"
    kar = b"MThd" + struct.pack(">IHHH", 6, max(fmt, 1), ntr + 1, div) + mid[14:] + b"MTrk" + struct.pack(">I", len(ev)) + ev
    put("midi", "kar", kar, fonte + " + testo karaoke generato")
    body = b"RMID" + b"data" + struct.pack("<I", len(mid)) + mid + (b"\0" if len(mid) % 2 else b"")
    put("midi", "rmi", b"RIFF" + struct.pack("<I", len(body)) + body, fonte + " (RIFF RMID)")


# moduli musicali: file di prova di libxmp (MIT) e OpenMPT (BSD)
XMP = "https://raw.githubusercontent.com/libxmp/libxmp/master/"


def gen_trackers():
    if not DOWNLOAD and not CACHE.exists():
        return
    tree = CACHE / "libxmp_tree.json"
    if not tree.exists() and DOWNLOAD:
        try:
            r = run(["gh", "api", "repos/libxmp/libxmp/git/trees/master?recursive=1", "--jq", "[.tree[] | select(.type==\"blob\") | [.path, .size]]"])
            CACHE.mkdir(parents=True, exist_ok=True)
            tree.write_bytes(r.stdout)
        except Exception:  # noqa: BLE001
            return
    try:
        files = json.loads(tree.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return
    # le prove di libxmp contengono anche file rotti apposta: si prende il primo (dal piu' piccolo, oltre 1 KB) che FFmpeg
    # (libopenmpt) legge davvero, al massimo 4 tentativi per estensione
    cands = {}
    for p, s in files:
        if not p.startswith("test-dev/data/"):
            continue
        name = p.rsplit("/", 1)[-1].lower()
        e = name.rsplit(".", 1)[-1] if "." in name else ""
        if e in CATS["audio"]["exts"] and 1000 < s < 400_000 and not any(w in p.lower() for w in BAD_WORDS):
            cands.setdefault(e, []).append((s, p))
    for e, lst in sorted(cands.items()):
        for _s, p in sorted(lst)[:4]:
            if not want("audio", e):
                break
            f = dl(XMP + p, "libxmp_" + p.replace("/", "_"))
            if f and run([FF, "-v", "error", "-i", str(f), "-t", "2", "-f", "null", "-"]).returncode == 0:
                put("audio", e, f, "libxmp " + p)
    for e in ("mptm", "xm", "s3m", "mod"):
        if want("audio", e):
            f = dl(f"https://raw.githubusercontent.com/OpenMPT/openmpt/master/test/test.{e}", f"openmpt_test.{e}")
            if f:
                put("audio", e, f, "OpenMPT test/test." + e)


def gen_fate():
    """audio, video e immagini mancanti: il file piu' piccolo con quell'estensione nella fate-suite di FFmpeg, poi
    nell'archivio di campioni samples.ffmpeg.org (file di prova pubblici, scaricati solo per il collaudo)."""
    _ffmpeg_samples("https://fate-suite.ffmpeg.org/", "fate_index.json", "fate", 25_000_000)
    _ffmpeg_samples("https://samples.ffmpeg.org/", "samples_ffmpeg_index.json", "sffmpeg", 30_000_000)


def _ffmpeg_samples(base, index, tag, max_size):
    idx = CACHE / index
    if not idx.exists():
        if not DOWNLOAD:
            return
        import re
        import concurrent.futures as cf
        rx = re.compile(r'<a href="([^"?][^"]*)">[^<]*</a>\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s+([\d.]+[KMG]?|-)')

        def size(s):
            mult = {"K": 1e3, "M": 1e6, "G": 1e9}
            return 0 if s == "-" else int(float(s[:-1]) * mult[s[-1]]) if s[-1] in mult else int(s)

        def ls(path):
            try:
                html = urllib.request.urlopen(base + path, timeout=60).read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                return [], []
            dirs, out = [], []
            for href, _, sz in rx.findall(html):
                (dirs if href.endswith("/") else out).append(path + href if href.endswith("/") else (path + href, size(sz)))
            return dirs, out
        files, todo = [], [""]
        with cf.ThreadPoolExecutor(12) as ex:
            while todo:
                res = list(ex.map(ls, todo))
                todo = []
                for d, f in res:
                    todo += d
                    files += f
        CACHE.mkdir(parents=True, exist_ok=True)
        idx.write_text(json.dumps(files), encoding="utf-8")
    files = json.loads(idx.read_text(encoding="utf-8"))
    for cat in ("media", "audio", "image", "archive"):
        best = {}
        for p, s in files:
            n = p.rsplit("/", 1)[-1].lower()
            e = n.rsplit(".", 1)[-1] if "." in n else ""
            # immagini dell'Atari (.spc Spectrum 512) non sono audio; i casi di bug segnalati restano solo come ultima scelta
            if cat != "image" and ("image-samples" in p or "cover_art" in p):
                continue
            if e in CATS[cat]["exts"] and 100 < s < max_size and (e not in best or s < best[e][1]):
                best[e] = (p, s)
        for e, (p, _s) in sorted(best.items()):
            if want(cat, e):
                f = dl(base + p, tag + "_" + urllib.request.unquote(p).replace("/", "_").replace(" ", "_"))
                if f:
                    put(cat, e, f, f"{base} {urllib.request.unquote(p)}")


# ============================================================ archivi
def gen_archives():
    src = tmp("archivio")
    src.mkdir(exist_ok=True)
    (src / "leggimi.txt").write_text("Campione di archivio\n", encoding="utf-8")
    (src / "cartella").mkdir(exist_ok=True)
    (src / "cartella" / "dati.csv").write_text("a;b\n1;2\n", encoding="utf-8")
    tarf = tmp("campione.tar")
    run([SZ, "a", "-ttar", str(tarf), str(src / "*")])

    def sz(ext, typ, inp=None, extra=()):
        if not want("archive", ext):
            return
        out = tmp(f"a.{ext}")
        out.unlink(missing_ok=True)
        r = run([SZ, "a", f"-t{typ}", *extra, str(out), *(inp or [str(src / "*")])])
        if r.returncode == 0 and out.exists():
            put("archive", ext, out, "generato (7-Zip)")
        else:
            print("  7-Zip non genera", ext, r.stdout.decode("utf-8", "replace")[-200:])

    for ext in ("zip", "zipx", "jar", "war", "ear", "apk", "aab", "xapk", "ipa", "appx", "msix", "appxbundle", "nupkg", "vsix", "xpi", "whl", "egg", "cbz", "ppkg"):
        sz(ext, "zip")
    for ext in ("7z", "cb7"):
        sz(ext, "7z")
    sz("tar", "tar")
    for ext in ("gz", "gzip", "tgz", "tpz"):
        sz(ext, "gzip", [str(tarf)])
    for ext in ("bz2", "bzip2", "tbz", "tbz2"):
        sz(ext, "bzip2", [str(tarf)])
    for ext in ("xz", "txz"):
        sz(ext, "xz", [str(tarf)])
    for ext in ("wim", "swm", "esd"):
        sz(ext, "wim")
    # .lzma (lzma alone) con Python, .z / .taz con compress non c'e': dai campioni scaricati se servono
    import lzma
    put("archive", "lzma", lzma.compress(tarf.read_bytes(), format=lzma.FORMAT_ALONE), "generato (lzma)")
    # cpio "newc", ar, deb (ar con data.tar.gz)
    put("archive", "cpio", _cpio({"leggimi.txt": b"Campione\n"}), "generato")
    put("archive", "ar", _ar({"leggimi.txt": b"Campione\n"}), "generato")
    put("archive", "a", _ar({"modulo.o": b"\x7fELF" + b"\0" * 60}), "generato")
    put("archive", "lib", _ar({"modulo.obj": b"\x4c\x01" + b"\0" * 60}), "generato")
    tgz = io.BytesIO()
    with gzip.GzipFile(fileobj=tgz, mode="wb") as g:
        g.write(tarf.read_bytes())
    put("archive", "deb", _ar({"debian-binary": b"2.0\n", "control.tar.gz": tgz.getvalue(), "data.tar.gz": tgz.getvalue()}), "generato")
    # CAB con makecab di Windows
    if want("archive", "cab") and shutil.which("makecab"):
        out = tmp("campione.cab")
        r = run(["makecab", str(src / "leggimi.txt"), str(out)])
        if out.exists():
            put("archive", "cab", out, "generato (makecab)")
    # ISO e VHD si scaricano (campioni pubblici) se mancano
    # KMZ resta alla mappa GIS


def _cpio(files):
    out = b""
    for i, (n, d) in enumerate(list(files.items()) + [("TRAILER!!!", b"")]):
        nb = n.encode() + b"\0"
        h = b"070701" + b"".join(b"%08X" % v for v in (i + 1, 0o100644 if d or n != "TRAILER!!!" else 0, 0, 0, 1, 0, len(d), 0, 0, 0, 0, len(nb), 0))
        out += h + nb + b"\0" * (-(len(h) + len(nb)) % 4) + d + b"\0" * (-len(d) % 4)
    return out


def _ar(files):
    out = b"!<arch>\n"
    for n, d in files.items():
        out += f"{n + '/':<16}{0:<12}{0:<6}{0:<6}{100644:<8}{len(d):<10}`\n".encode() + d + (b"\n" if len(d) % 2 else b"")
    return out


# ============================================================ Office (via COM se c'e' Office) e formati aperti
def gen_office():
    docx = SAMPLES / "relazione.docx"
    xlsx = SAMPLES / "computo.xlsx"
    pptx = SAMPLES / "presentazione.pptx"
    put("word", "docx", docx, "tests/samples")
    put("sheet", "xlsx", xlsx, "tests/samples")
    put("pptx", "pptx", pptx, "tests/samples")
    put("sheet", "csv", SAMPLES / "dati.csv", "tests/samples")
    put("sheet", "tsv", "voce\tquantita\nscavo\t12\nmuro\t3,5\n", "generato")
    try:
        import pythoncom  # noqa: F401
        import win32com.client as wc
    except Exception:  # noqa: BLE001
        print("  Office via COM non disponibile: formati Office binari solo da campioni scaricati")
        return
    wtmp = OUT / "_lavoro" / "office"
    wtmp.mkdir(parents=True, exist_ok=True)

    def com(app_name, opener, saves, src):
        need = [(c, e, f) for c, e, f in saves if want(c, e)]
        if not need:
            return
        try:
            app = wc.DispatchEx(app_name)
        except Exception as e:  # noqa: BLE001
            print("  ", app_name, "non disponibile:", e)
            return
        try:
            app.DisplayAlerts = 0 if app_name != "PowerPoint.Application" else 1
        except Exception:  # noqa: BLE001
            pass
        try:
            doc = opener(app, str(src))
            for cat, ext, fmt in need:
                out = wtmp / f"campione.{ext}"
                out.unlink(missing_ok=True)
                try:
                    if app_name == "Word.Application":
                        doc.SaveAs2(str(out), FileFormat=fmt)
                    elif app_name == "Excel.Application":
                        doc.SaveAs(str(out), FileFormat=fmt)
                    else:
                        doc.SaveAs(str(out), fmt)
                    put(cat, ext, out, f"generato ({app_name.split('.')[0]})")
                except Exception as e:  # noqa: BLE001
                    print(f"  {app_name} non salva .{ext}: {e}")
            try:
                doc.Close(False) if app_name != "PowerPoint.Application" else doc.Close()
            except Exception:  # noqa: BLE001
                pass
        finally:
            try:
                app.Quit()
            except Exception:  # noqa: BLE001
                pass

    com("Word.Application", lambda a, p: a.Documents.Open(p, ReadOnly=True, AddToRecentFiles=False), [
        ("word", "docm", 13), ("word", "dotx", 14), ("word", "dotm", 15), ("office-lo", "doc", 0), ("office-lo", "dot", 1), ("office-lo", "rtf", 6),
        ("office-lo", "odt", 23), ("office-lo", "ott", 23), ("dwf", "xps", 18), ("html", "mht", 9), ("text", "txt", 2)], docx)
    com("Excel.Application", lambda a, p: a.Workbooks.Open(p, ReadOnly=True, AddToMru=False), [
        ("sheet", "xlsm", 52), ("sheet", "xlsb", 50), ("sheet", "xls", 56), ("sheet", "xltx", 54), ("sheet", "xltm", 53), ("sheet", "xlt", 17),
        ("sheet", "ods", 60), ("sheet", "dif", 9), ("sheet", "slk", 2), ("sheet", "sylk", 2), ("sheet", "prn", 36)], xlsx)
    com("PowerPoint.Application", lambda a, p: a.Presentations.Open(p, True, False, False), [
        ("pptx", "pptm", 25), ("pptx", "potx", 26), ("pptx", "potm", 27), ("pptx", "ppsx", 28), ("pptx", "ppsm", 29), ("office-lo", "ppt", 1),
        ("office-lo", "pps", 7), ("office-lo", "pot", 5), ("office-lo", "odp", 35), ("office-lo", "otp", 35)], pptx)
    # Publisher: pubblicazione nuova con una casella di testo
    if want("publisher", "pub"):
        try:
            pub = wc.DispatchEx("Publisher.Application")
            d = pub.NewDocument()
            d.Pages(1).Shapes.AddTextbox(1, 72, 72, 300, 60).TextFrame.TextRange.Text = "Campione di pubblicazione"
            out = wtmp / "campione.pub"
            out.unlink(missing_ok=True)
            d.SaveAs(str(out))
            d.Close()
            pub.Quit()
            put("publisher", "pub", out, "generato (Publisher)")
        except Exception as e:  # noqa: BLE001
            print("  Publisher non disponibile:", e)


def gen_opendoc_flat():
    """OpenDocument piatti (.fodt/.fods/.fodp/.fodg) e OpenOffice 1 (.sxw...), AbiWord: scritti a mano, minimi ma validi."""
    ns = ('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
          'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
          'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
          'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"')
    body = {
        "text": '<office:text><text:h text:outline-level="1">Campione</text:h><text:p>Testo del documento.</text:p></office:text>',
        "spreadsheet": '<office:spreadsheet><table:table table:name="Foglio1"><table:table-row><table:table-cell office:value-type="string"><text:p>voce</text:p></table:table-cell>'
                       '<table:table-cell office:value-type="float" office:value="12"><text:p>12</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>',
        "presentation": '<office:presentation><draw:page draw:name="Pagina1"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="10cm" svg:height="2cm"><draw:text-box>'
                        '<text:p>Campione</text:p></draw:text-box></draw:frame></draw:page></office:presentation>',
        "drawing": '<office:drawing><draw:page draw:name="Pagina1"><draw:rect svg:x="2cm" svg:y="2cm" svg:width="6cm" svg:height="3cm"/></draw:page></office:drawing>',
    }
    mt = {"text": "text", "spreadsheet": "spreadsheet", "presentation": "presentation", "drawing": "graphics"}
    for ext, kind, cat in (("fodt", "text", "office-lo"), ("fods", "spreadsheet", "sheet"), ("fodp", "presentation", "office-lo"), ("fodg", "drawing", "office-lo")):
        put(cat, ext, f'<?xml version="1.0" encoding="UTF-8"?>\n<office:document {ns} office:mimetype="application/vnd.oasis.opendocument.{mt[kind]}">'
            f"<office:body>{body[kind]}</office:body></office:document>\n", "generato")
    for ext, kind, tmpl in (("odg", "drawing", False), ("otg", "drawing", True)):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            mime = f"application/vnd.oasis.opendocument.graphics{'-template' if tmpl else ''}"
            z.writestr(zipfile.ZipInfo("mimetype"), mime)
            z.writestr("content.xml", f'<?xml version="1.0" encoding="UTF-8"?><office:document-content {ns}><office:body>{body[kind]}</office:body></office:document-content>')
            z.writestr("META-INF/manifest.xml", '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">'
                       f'<manifest:file-entry manifest:full-path="/" manifest:media-type="{mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>')
        put("office-lo", ext, b.getvalue(), "generato")
    # MathML di LibreOffice Math (.mml)
    put("office-lo", "mml", '<?xml version="1.0" encoding="UTF-8"?>\n<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow></math>\n', "generato")


# ============================================================ firme, certificati
def gen_signed_cert():
    put("signed", "p7m", SAMPLES / "contratto_firmato.pdf.p7m", "tests/samples")
    fx = SAMPLES / "fx"
    for ext, name in (("cer", "certificato.cer"), ("crt", "certificato.crt"), ("pem", "catena.pem"), ("der", "radice.der"), ("p7b", "catena.p7b"),
                      ("p12", "identita_password_prova.p12"), ("csr", "richiesta.csr"), ("crl", "revoche.crl")):
        put("cert", ext, fx / name, "tests/samples/fx")
    put("cert", "pfx", fx / "identita_password_prova.p12", "tests/samples/fx")
    for it in items:  # password del certificato di prova: il collaudo la scrive nella finestra che la chiede
        if it["cat"] == "cert" and it["ext"] in ("p12", "pfx"):
            it["password"] = "prova"
    from asn1crypto import cms, core, tsp
    p7m = cms.ContentInfo.load((SAMPLES / "contratto_firmato.pdf.p7m").read_bytes())
    sd = p7m["content"]
    certs = sd["certificates"]
    # firma separata .p7s accanto al documento (stesso nome senza .p7s): contenuto tolto dalla busta
    content = sd["encap_content_info"]["content"].native
    det = cms.ContentInfo({"content_type": "signed_data", "content": cms.SignedData({
        "version": sd["version"], "digest_algorithms": sd["digest_algorithms"],
        "encap_content_info": {"content_type": "data"}, "certificates": certs, "signer_infos": sd["signer_infos"]})})
    p = put("signed", "p7s", det.dump(), "derivato da tests/samples (firma separata)", name="contratto.pdf.p7s")
    if p:
        (p.parent / "contratto.pdf").write_bytes(content)
    only = cms.ContentInfo({"content_type": "signed_data", "content": cms.SignedData({
        "version": "v1", "digest_algorithms": [], "encap_content_info": {"content_type": "data"}, "certificates": certs, "signer_infos": []})}).dump()
    put("signed", "p7c", only, "derivato da tests/samples (solo certificati)")
    put("signed", "spc", only, "derivato da tests/samples (solo certificati)")
    # marca temporale di prova con il servizio fittizio di pyHanko (nessuna rete)
    try:
        import hashlib
        from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper
        from cryptography.hazmat.primitives.serialization import pkcs12
        from asn1crypto import keys, x509 as ax509
        import datetime as dt
        from cryptography import x509 as cx509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
        del pkcs12
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)  # servizio di marca di prova: solo RSA
        name = cx509.Name([cx509.NameAttribute(NameOID.COMMON_NAME, "Marca temporale di prova")])
        now = dt.datetime.now(dt.timezone.utc)
        cert = (cx509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(1)
                .not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=3650))
                .add_extension(cx509.ExtendedKeyUsage([ExtendedKeyUsageOID.TIME_STAMPING]), critical=True).sign(key, hashes.SHA256()))
        tsa_cert = ax509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))
        tsa_key = keys.PrivateKeyInfo.load(key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        ts = DummyTimeStamper(tsa_cert=tsa_cert, tsa_key=tsa_key, certs_to_embed=[])
        raw = (SAMPLES / "contratto_firmato.pdf.p7m").read_bytes()
        req = tsp.TimeStampReq({"version": 1, "message_imprint": {"hash_algorithm": {"algorithm": "sha256"}, "hashed_message": hashlib.sha256(raw).digest()}, "cert_req": True})
        token = ts.request_tsa_response(req)["time_stamp_token"]
        from mbvisual.signed import TimeStampedData  # schema RFC 5544 gia' definito nel motore
        def der(tag, body):
            n = len(body)
            ln = bytes([n]) if n < 128 else bytes([0x80 | ((n.bit_length() + 7) // 8)]) + n.to_bytes((n.bit_length() + 7) // 8, "big")
            return bytes([tag]) + ln + body
        ev = der(0xA0, der(0x30, token.dump()))  # Evidence: tstEvidence [0] SEQUENCE OF TimeStampAndCRL (RFC 5544)
        # TimeStampedData scritto a mano (asn1crypto non accetta l'etichetta [0] dentro un campo Any): versione, contenuto, evidenza
        tsd = der(0x30, b"\x02\x01\x01" + der(0x04, raw) + ev)
        TimeStampedData.load(tsd)["content"].native  # stessa struttura che legge il motore (mbvisual/signed.py)
        oid = bytes.fromhex("2a864886f70d010910011f")  # 1.2.840.113549.1.9.16.1.31 id-ct-timestampedData
        put("signed", "tsd", der(0x30, der(0x06, oid) + der(0xA0, tsd)), "generato (marca di prova pyHanko)")
        tsr = tsp.TimeStampResp({"status": {"status": "granted"}, "time_stamp_token": token}).dump()
        import base64
        b = "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"B\"\r\n\r\n"
        b += "--B\r\nContent-Type: application/pkcs7-mime; name=\"contratto.pdf.p7m\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" + base64.encodebytes(raw).decode().replace("\n", "\r\n")
        b += "\r\n--B\r\nContent-Type: application/timestamp-reply; name=\"contratto.tsr\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" + base64.encodebytes(tsr).decode().replace("\n", "\r\n")
        b += "\r\n--B--\r\n"
        put("signed", "m7m", b.encode(), "generato (marca di prova pyHanko)")
    except Exception as e:  # noqa: BLE001
        print("  marca temporale di prova non generata:", e)


# ============================================================ campioni del repository e degli altri formati
def gen_repo():
    S = SAMPLES
    pick = {
        ("pdf", "pdf"): S / "misure" / "pianta_1-100.pdf",
        ("cad2d", "dxf"): S / "pianta.dxf", ("cad2d", "dwg"): next((p for p in S.rglob("*.dwg") if "danneggiati" not in p.parts), None),
        ("mesh3d", "ifc"): S / "misure" / "edificio.ifc", ("mesh3d", "stl"): S / "cubo.stl", ("mesh3d", "obj"): S / "cubo.obj",
        ("email", "eml"): S / "messaggio.eml", ("email", "msg"): S / "danneggiati" / "riunione.msg",  # l'originale integro (ATTESI.json)
        ("database", "sqlite"): S / "archivio_commesse.sqlite", ("gis", "gpkg"): S / "gis" / "province_rdn2008_utm33.gpkg",
        ("gis", "geojson"): S / "gis" / "centri_abitati_etrs89_utm32.geojson", ("gis", "kml"): S / "gis" / "citta_italiane.kml",
        ("gis", "kmz"): S / "gis" / "province_nord.kmz", ("gis", "gpx"): S / "gis" / "fiume_po.gpx", ("gis", "tif"): S / "gis" / "rilievo_garda_utm32.tif",
        ("image", "tif"): S / "immagine.tif",
        ("visio", "vsdx"): S / "visio" / "vx_test3_house.vsdx", ("visio", "vsdm"): S / "visio" / "poi_SimpleMacro.vsdm", ("visio", "vsd"): S / "visio" / "poi_v5_Connection_Types.vsd",
        ("dicom", "dcm"): S / "fx" / "CT_small.dcm", ("calendar", "ics"): S / "fx" / "cantiere.ics", ("contacts", "vcf"): S / "fx" / "rubrica.vcf",
        ("hpgl", "plt"): S / "fx" / "pianta_plotter.plt", ("hpgl", "hpgl"): S / "fx" / "schema.hpgl", ("hpgl", "hgl"): S / "fx" / "spirale_pe.hgl",
        ("hpgl", "hpg"): S / "fx" / "schema.hpgl",
        ("scidata", "h5"): S / "fx" / "misure.h5", ("scidata", "hdf5"): S / "fx" / "misure.h5", ("scidata", "he5"): S / "fx" / "misure.h5",
        ("scidata", "nc"): S / "fx" / "meteo.nc", ("scidata", "parquet"): S / "fx" / "ore_commesse.parquet", ("scidata", "feather"): S / "fx" / "ore_commesse.feather",
        ("scidata", "arrow"): S / "fx" / "ore_commesse.arrow",
        ("iwork", "pages"): S / "fx" / "pubblici" / "testPages2013.pages", ("iwork", "numbers"): S / "fx" / "pubblici" / "testNumbers2013.numbers",
        ("iwork", "key"): S / "fx" / "pubblici" / "testKeynote2013.key",
        ("revit", "rvt"): S / "fx" / "pubblici" / "Empty-Metric.rvt", ("revit", "rfa"): S / "fx" / "pubblici" / "withModelText.rfa",
        ("pointcloud", "xyz"): next((p for p in S.rglob("*.xyz") if "danneggiati" not in p.parts), None), ("media", "mp4"): S / "video_prova.mp4", ("audio", "wav"): S / "tono.wav",
    }
    for (cat, ext), p in pick.items():
        if p and Path(p).exists():
            put(cat, ext, Path(p), "tests/samples")
    # shapefile con i file accanto
    shp = S / "gis" / "province_gaussboaga.shp"
    if want("gis", "shp") and shp.exists():
        put("gis", "shp", shp, "tests/samples/gis")
        for e in ("dbf", "shx", "prj"):
            side("gis", "shp", f"campione.{e}", shp.with_suffix("." + e))
    tif = S / "gis" / "rilievo_garda_utm32.tif"
    put("gis", "tiff", tif, "tests/samples/gis")
    # zip con shapefile = mappa
    if want("gis", "zip") and shp.exists():
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            for e in ("shp", "dbf", "shx", "prj"):
                z.write(shp.with_suffix("." + e), "province." + e)
        put("gis", "zip", b.getvalue(), "derivato da tests/samples/gis")
    # GeoJSON -> TopoJSON minimo
    put("gis", "topojson", json.dumps({"type": "Topology", "arcs": [[[0, 0], [1, 1]]], "objects": {"linee": {"type": "GeometryCollection", "geometries": [
        {"type": "LineString", "arcs": [0]}]}}, "transform": {"scale": [0.01, 0.01], "translate": [11.3, 44.5]}}), "generato")
    # DICOM con l'estensione lunga
    put("dicom", "dicom", S / "fx" / "CT_small.dcm", "tests/samples/fx")
    # calendari e contatti
    ics = (S / "fx" / "cantiere.ics").read_bytes()
    for ext in ("ical", "icalendar", "vcs"):
        put("calendar", ext, ics, "tests/samples/fx")
    put("calendar", "ifb", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Campione//IT\r\nBEGIN:VFREEBUSY\r\nDTSTART:20261028T080000Z\r\nDTEND:20261028T180000Z\r\n"
        "FREEBUSY:20261028T090000Z/20261028T100000Z\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n", "generato")
    put("contacts", "vcard", S / "fx" / "rubrica.vcf", "tests/samples/fx")
    # database SQLite con le altre estensioni
    db = S / "archivio_commesse.sqlite"
    for ext in ("sqlite3", "db", "db3", "s3db", "sl3", "sdb"):
        put("database", ext, db, "tests/samples")
    put("database", "gpkg", S / "gis" / "province_rdn2008_utm33.gpkg", "tests/samples/gis")
    if want("database", "mbtiles"):
        import sqlite3
        p = tmp("campione.mbtiles")
        p.unlink(missing_ok=True)
        c = sqlite3.connect(p)
        c.executescript("CREATE TABLE metadata (name text, value text); CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);"
                        "INSERT INTO metadata VALUES ('name','Campione'),('format','png');")
        png = io.BytesIO()
        from PIL import Image
        Image.new("RGB", (256, 256), (200, 220, 240)).save(png, "PNG")
        c.execute("INSERT INTO tiles VALUES (0,0,0,?)", (png.getvalue(),))
        c.commit()
        c.close()
        put("database", "mbtiles", p, "generato")
    # email
    eml = S / "messaggio.eml"
    put("email", "emlx", f"{eml.stat().st_size}\n".encode() + eml.read_bytes() + b'<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n', "derivato da tests/samples")
    mbox = b"From campione@esempio.it Wed Oct 28 10:00:00 2026\n" + eml.read_bytes().replace(b"\r\n", b"\n") + b"\n"
    put("email", "mbox", mbox, "derivato da tests/samples")
    put("email", "mbx", mbox, "derivato da tests/samples")
    # ebook EPUB minimo
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip")
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                   '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
                   '<dc:identifier id="id">campione</dc:identifier><dc:title>Campione</dc:title><dc:language>it</dc:language><meta property="dcterms:modified">2026-10-28T00:00:00Z</meta></metadata>'
                   '<manifest><item id="c1" href="cap1.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>'
                   '<spine><itemref idref="c1"/></spine></package>')
        z.writestr("OEBPS/nav.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="cap1.xhtml">Capitolo 1</a></li></ol></nav></body></html>')
        z.writestr("OEBPS/cap1.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capitolo 1</title></head><body><h1>Capitolo 1</h1><p>Testo del libro.</p></body></html>')
    put("ebook", "epub", b.getvalue(), "generato")
    # caratteri dalla cartella di Windows
    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    for ext, name in (("ttf", "arial.ttf"), ("ttc", "cambria.ttc"), ("otf", None)):
        p = fonts / name if name else None
        if p and p.exists():
            put("font", ext, p, "Windows Fonts")
    try:
        from fontTools.ttLib import TTFont
        f = TTFont(fonts / "arial.ttf")
        for flavor, ext in (("woff", "woff"), ("woff2", "woff2")):
            if want("font", ext):
                f.flavor = flavor
                b = io.BytesIO()
                f.save(b)
                put("font", ext, b.getvalue(), "derivato da Windows Fonts")
    except Exception as e:  # noqa: BLE001
        print("  woff non generati:", e)
    for p in fonts.glob("*.otf"):
        put("font", "otf", p, "Windows Fonts")
        break
    # progetto video e pubblicazione: esempi dell'app
    es = Path.home() / ".mbvisual" / "esempi"
    put("publisher", "mbpub", es / "brochure.mbpub", "esempi dell'app") if (es / "brochure.mbpub").exists() else None
    if (es / "video_cantiere.mbvid").exists():
        p = put("videoproject", "mbvid", es / "video_cantiere.mbvid", "esempi dell'app")
        if p:
            for m in ("cantiere_1.mp4", "cantiere_2.mp4", "video_prova.mp4"):
                if (es / m).exists():
                    shutil.copyfile(es / m, p.parent / m)


def gen_cad_3d():
    import ezdxf
    doc = ezdxf.new("R2018", setup=True)
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0))
    msp.add_circle((50, 50), 20)
    msp.add_text("Campione", height=5).set_placement((10, 80))
    p = tmp("campione.dxf")
    doc.saveas(p)
    put("cad2d", "dxf", p, "generato (ezdxf)")
    good = sorted((f for f in (Path.home() / ".mbvisual" / "dwg3d-campioni").rglob("*.dwg") if f.stat().st_size < 3_000_000), key=lambda f: f.stat().st_size)
    if good:  # modello di disegno .dwt: stesso formato del DWG (campioni di prova di un'altra sessione, non nel repository)
        put("cad2d", "dwg", good[0], "dwg3d-campioni")
        put("cad2d", "dwt", good[0], "dwg3d-campioni (stesso formato del DWG)")
    # DXB: DXF binario di ezdxf? (no: DXB e' un'altra cosa) -> solo se scaricato
    # mesh: trimesh se installato, altrimenti scritte a mano
    v = [(0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0), (0, 0, 10), (10, 0, 10), (10, 10, 10), (0, 10, 10)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    ply = "ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n"
    ply += "".join(f"{a} {b} {c}\n" for a, b, c in v) + "".join(f"3 {a} {b} {c}\n" for a, b, c in f)
    put("mesh3d", "ply", ply, "generato")
    vtk = "# vtk DataFile Version 3.0\nCubo\nASCII\nDATASET POLYDATA\nPOINTS 8 float\n" + "".join(f"{a} {b} {c}\n" for a, b, c in v)
    vtk += f"POLYGONS 12 48\n" + "".join(f"3 {a} {b} {c}\n" for a, b, c in f)
    put("mesh3d", "vtk", vtk, "generato")
    pts = " ".join(f"{a} {b} {c}" for a, b, c in v)
    conn = " ".join(f"{a} {b} {c}" for a, b, c in f)
    offs = " ".join(str(3 * (i + 1)) for i in range(len(f)))
    put("mesh3d", "vtp", f'<?xml version="1.0"?><VTKFile type="PolyData" version="0.1"><PolyData><Piece NumberOfPoints="8" NumberOfPolys="12"><Points>'
        f'<DataArray type="Float32" NumberOfComponents="3" format="ascii">{pts}</DataArray></Points><Polys><DataArray type="Int32" Name="connectivity" format="ascii">{conn}</DataArray>'
        f'<DataArray type="Int32" Name="offsets" format="ascii">{offs}</DataArray></Polys></Piece></PolyData></VTKFile>\n', "generato")
    put("mesh3d", "pcd", "# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 8\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 8\nDATA ascii\n"
        + "".join(f"{a} {b} {c}\n" for a, b, c in v), "generato")
    wrl = "#VRML V2.0 utf8\nShape { appearance Appearance { material Material { diffuseColor 0.9 0.5 0.2 } } geometry Box { size 10 10 10 } }\n"
    put("mesh3d", "wrl", wrl, "generato")
    put("mesh3d", "vrml", wrl, "generato")
    put("mesh3d", "amf", '<?xml version="1.0" encoding="UTF-8"?>\n<amf unit="millimeter"><object id="1"><mesh><vertices>'
        + "".join(f"<vertex><coordinates><x>{a}</x><y>{b}</y><z>{c}</z></coordinates></vertex>" for a, b, c in v) + "</vertices><volume>"
        + "".join(f"<triangle><v1>{a}</v1><v2>{b}</v2><v3>{c}</v3></triangle>" for a, b, c in f) + "</volume></mesh></object></amf>\n", "generato")
    # 3MF minimo
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>'
                   + "".join(f'<vertex x="{a}" y="{b}" z="{c}"/>' for a, b, c in v) + "</vertices><triangles>"
                   + "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in f) + '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>')
    put("mesh3d", "3mf", b.getvalue(), "generato")
    # glTF/GLB con l'esportatore minimo scritto qui
    import base64
    pos = b"".join(struct.pack("<3f", *p) for p in v)
    idx = b"".join(struct.pack("<3H", *t) for t in f)
    buf = pos + idx
    gl = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "Cubo"}],
          "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
          "buffers": [{"byteLength": len(buf)}], "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
                                                                  {"buffer": 0, "byteOffset": len(pos), "byteLength": len(idx), "target": 34963}],
          "accessors": [{"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3", "min": [0, 0, 0], "max": [10, 10, 10]},
                        {"bufferView": 1, "componentType": 5123, "count": 36, "type": "SCALAR"}]}
    g2 = dict(gl, buffers=[{"byteLength": len(buf), "uri": "data:application/octet-stream;base64," + base64.b64encode(buf).decode()}])
    put("mesh3d", "gltf", json.dumps(g2), "generato")
    js = json.dumps(gl).encode()
    js += b" " * (-len(js) % 4)
    bb = buf + b"\0" * (-len(buf) % 4)
    glb = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(bb)) + struct.pack("<I", len(js)) + b"JSON" + js + struct.pack("<I", len(bb)) + b"BIN\0" + bb
    put("mesh3d", "glb", glb, "generato")
    put("mesh3d", "pdb", "HEADER    CAMPIONE\nATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00  0.00           N\n"
        "ATOM      2  CA  ALA A   1      11.639   6.071  -5.147  1.00  0.00           C\nATOM      3  C   ALA A   1      13.146   6.334  -5.111  1.00  0.00           C\nEND\n", "generato")
    put("mesh3d", "bvh", "HIERARCHY\nROOT Bacino\n{\n OFFSET 0 0 0\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n JOINT Gamba\n {\n  OFFSET 0 -10 0\n"
        "  CHANNELS 3 Zrotation Xrotation Yrotation\n  End Site\n  {\n   OFFSET 0 -10 0\n  }\n }\n}\nMOTION\nFrames: 2\nFrame Time: 0.04\n0 0 0 0 0 0 0 0 0\n0 0 0 0 10 0 0 0 0\n", "generato")
    # VOX (MagicaVoxel): un cubo 2x2x2
    size = struct.pack("<3I", 2, 2, 2)
    xyzi = struct.pack("<I", 8) + b"".join(bytes([x, y, z, 1]) for x in range(2) for y in range(2) for z in range(2))
    chunk = lambda cid, data: cid + struct.pack("<II", len(data), 0) + data  # noqa: E731
    main = chunk(b"SIZE", size) + chunk(b"XYZI", xyzi)
    put("mesh3d", "vox", b"VOX " + struct.pack("<I", 150) + b"MAIN" + struct.pack("<II", 0, len(main)) + main, "generato")
    # STEP/IGES/BREP con OpenCascade (cadquery-ocp) se c'e'
    try:
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
        from OCP.IGESControl import IGESControl_Writer
        from OCP.BRepTools import BRepTools
        box = BRepPrimAPI_MakeBox(10, 20, 30).Shape()
        st = tmp("campione.step")
        w = STEPControl_Writer()
        w.Transfer(box, STEPControl_AsIs)
        w.Write(str(st))
        for ext in ("step", "stp", "p21"):
            put("cad3d", ext, st, "generato (OpenCascade)")
        if want("cad3d", "stpz"):
            put("cad3d", "stpz", gzip.compress(st.read_bytes()), "generato (OpenCascade)")
        ig = tmp("campione.igs")
        iw = IGESControl_Writer("MM", 0)
        iw.AddShape(box)
        iw.ComputeModel()
        iw.Write(str(ig))
        for ext in ("iges", "igs"):
            put("cad3d", ext, ig, "generato (OpenCascade)")
        br = tmp("campione.brep")
        BRepTools.Write_s(box, str(br))
        for ext in ("brep", "brp"):
            put("cad3d", ext, br, "generato (OpenCascade)")
    except Exception as e:  # noqa: BLE001
        print("  OpenCascade non disponibile per STEP/IGES/BREP:", e)
    # nuvole di punti
    import numpy as np
    rng = np.random.default_rng(1)
    pts3 = rng.random((2000, 3)) * [10, 10, 2]
    put("pointcloud", "pts", f"{len(pts3)}\n" + "".join(f"{a:.3f} {b:.3f} {c:.3f} 100 200 120 80\n" for a, b, c in pts3), "generato")
    put("pointcloud", "xyz", "".join(f"{a:.3f} {b:.3f} {c:.3f}\n" for a, b, c in pts3), "generato")
    try:
        import laspy
        hdr = laspy.LasHeader(point_format=3, version="1.2")
        hdr.scales = [0.001] * 3
        las = laspy.LasData(hdr)
        las.x, las.y, las.z = pts3[:, 0], pts3[:, 1], pts3[:, 2]
        p = tmp("campione.las")
        las.write(p)
        put("pointcloud", "las", p, "generato (laspy)")
        try:
            p2 = tmp("campione.laz")
            las.write(p2)
            put("pointcloud", "laz", p2, "generato (laspy + lazrs)")
        except Exception as e:  # noqa: BLE001
            print("  laz:", e)
    except Exception as e:  # noqa: BLE001
        print("  las:", e)
    try:
        import pye57
        p = tmp("campione.e57")
        p.unlink(missing_ok=True)
        e = pye57.E57(str(p), mode="w")
        e.write_scan_raw({"cartesianX": pts3[:, 0], "cartesianY": pts3[:, 1], "cartesianZ": pts3[:, 2]})
        e.close()
        put("pointcloud", "e57", p, "generato (pye57)")
    except Exception as ex:  # noqa: BLE001
        print("  e57:", ex)
    # PTX: una scansione 2000x1 con la matrice identita'
    ptx = "1\n2000\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n" + "".join(f"{a:.3f} {b:.3f} {c:.3f} 0.5\n" for a, b, c in pts3)
    ptx = ptx.replace("1\n2000\n", "2000\n1\n", 1)
    put("pointcloud", "ptx", ptx, "generato")
    # BCF: segnalazione minima 2.1
    b = io.BytesIO()
    guid = "3f2a1b9c-6d4e-4f00-9a1b-2c3d4e5f6a70"
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("bcf.version", '<?xml version="1.0" encoding="UTF-8"?><Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>')
        z.writestr(f"{guid}/markup.bcf", f'<?xml version="1.0" encoding="UTF-8"?><Markup><Topic Guid="{guid}" TopicType="Issue" TopicStatus="Open">'
                   "<Title>Campione</Title><CreationDate>2026-10-28T10:00:00+00:00</CreationDate><CreationAuthor>prova@esempio.it</CreationAuthor></Topic>"
                   f'<Comment Guid="4f2a1b9c-6d4e-4f00-9a1b-2c3d4e5f6a71"><Date>2026-10-28T10:00:00+00:00</Date><Author>prova@esempio.it</Author><Comment>Nota</Comment>'
                   f'<Topic Guid="{guid}"/></Comment></Markup>')
    put("bcf", "bcfzip", b.getvalue(), "generato")
    put("bcf", "bcf", b.getvalue(), "generato")


def gen_project():
    pc = Path.home() / ".mbvisual" / "project-campioni"
    if pc.exists():
        for ext in ("mpp", "mpt", "mpx", "xer", "pmxml", "gan", "xml"):
            cands = sorted((p for p in pc.rglob("*." + ext) if p.stat().st_size < 3_000_000), key=lambda p: p.stat().st_size)
            if ext == "xml":
                cands = [p for p in cands if b"schemas.microsoft.com/project" in p.read_bytes()[:3000]]
            if ext in ("mpp", "mpt"):  # solo i file che il lettore dell'app accetta (Project 2007 e successivi; 98-2003 hanno un messaggio apposta)
                from mbvisual import mpp

                def _ok(f):
                    try:
                        mpp.read(str(f))
                        return True
                    except BaseException:  # noqa: BLE001  (MppError non deriva da Exception)
                        return False
                cands = next(([f] for f in cands if _ok(f)), [])
            for p in cands[:1]:
                put("project", ext, p, "project-campioni (MPXJ/GanttProject)")


def gh_tree(repo, branch):
    """elenco dei file di un repository GitHub pubblico (gh autenticato), in cache."""
    p = CACHE / ("tree_" + repo.replace("/", "_") + ("" if branch in ("dev", "main", "master") else "_" + branch) + ".json")
    if not p.exists():
        if not DOWNLOAD:
            return []
        r = run(["gh", "api", f"repos/{repo}/git/trees/{branch}?recursive=1", "--jq", '[.tree[] | select(.type=="blob") | [.path, .size]]'])
        if r.returncode:
            print("  elenco non disponibile:", repo)
            return []
        CACHE.mkdir(parents=True, exist_ok=True)
        p.write_bytes(r.stdout)
    return json.loads(p.read_text(encoding="utf-8"))


BAD_WORDS = ("leak", "hang", "huge", "premature", "invalid", "bad", "overflow", "underflow", "uaf", "corrupt", "trunc", "empty", "oob",
             "fuzz", "crash", "timeout", "oom", "toolong", "encrypt", "noeof", "unsupported", "incomplete", "missing", "broken")


def gh_pick(repo, branch, cat, wanted, max_size=30_000_000, uu=False):
    """wanted = {ext: regex sul percorso}; per ogni estensione il file piu' piccolo che corrisponde (escluse le prove di file rotti)."""
    import re
    files = gh_tree(repo, branch)
    for ext, rx in wanted.items():
        if not want(cat, ext):
            continue
        c = sorted(((p, s) for p, s in files if re.search(rx, p, re.I) and 0 < s < max_size and not any(w in p.lower() for w in BAD_WORDS)), key=lambda x: x[1])
        for p, _s in c[:3]:
            f = dl(f"https://raw.githubusercontent.com/{repo}/{branch}/" + urllib.request.quote(p), repo.split("/")[0] + "_" + p.replace("/", "_"))
            if not f:
                continue
            data = f.read_bytes()
            if uu:  # file di prova di libarchive: uuencode
                import binascii
                out = b""
                for line in data.decode("latin-1").splitlines()[1:]:
                    if line.strip() in ("end", "`", ""):
                        if line.strip() == "end":
                            break
                        continue
                    try:
                        out += binascii.a2b_uu(line)
                    except binascii.Error:
                        n = (((ord(line[0]) - 32) & 63) * 4 + 5) // 3
                        out += binascii.a2b_uu(line[:n])
                data = out
            put(cat, ext, data, f"{repo} {p}")
            break


def gen_public():
    """file pubblici scaricati (solo per le prove): modelli di esempio di three.js, JT, U3D, DWF, archivi di prova di libarchive,
    RAW di raw.pixls.us (CC0), caratteri OpenType di Adobe (OFL)."""
    gh_pick("mrdoob/three.js", "dev", "mesh3d", {"fbx": r"examples/models/fbx/monkey\.fbx$", "3ds": r"examples/models/3ds/.*\.3ds$",
                                                   "dae": r"examples/models/collada/.*\.dae$", "usdz": r"examples/models/usdz/.*\.usdz$",
                                                   "lwo": r"examples/models/lwo/.*\.lwo$", "md2": r"examples/models/md2/.*\.md2$",
                                                   "3dm": r"examples/models/3dm/.*\.3dm$"})
    gh_pick("mrdoob/three.js", "r169", "mesh3d", {"lwo": r"examples/models/lwo/.*\.lwo$"})  # tolto dagli esempi dopo la r169
    gh_pick("Arsanias/Delphi-JT-Loader", "main", "vis3d", {"jt": r"Examples/.*\.jt$"})
    gh_pick("ralovich/u3d-db", "main", "vis3d", {"u3d": r"u3ds/3D \(1\)\.stream-5\.u3d$"})
    gh_pick("aspose-cad/Aspose.CAD-for-.NET", "master", "dwf", {"dwf": r"blocks_and_tables\.dwf$", "dwfx": r"\.dwfx$"})
    gh_pick("kveretennicov/dwf-toolkit", "master", "dwf", {"w2d": r"\.w2d$", "dwf": r"\.dwf$"})
    gh_pick("libarchive/libarchive", "master", "archive", {
        "rar": r"test_read_format_rar5?(_stored|_multi_lzss_blocks|)\.rar\.uu$", "arj": r"\.arj\.uu$", "lha": r"test_read_format_lha.*\.lha\.uu$",
        "lzh": r"test_read_format_lha.*\.lzh\.uu$", "iso": r"test_read_format_iso[^/]*\.iso\.uu$", "xar": r"test_read_format_xar[^/]*\.xar\.uu$",
        "rpm": r"\.rpm\.uu$", "z": r"cat/test/test_expand\.Z\.uu$", "taz": r"\.tar\.Z\.uu$", "cab": r"test_read_format_cab_1\.cab\.uu$",
        "cbr": r"test_read_format_rar5?(_stored|)\.rar\.uu$"}, uu=True)
    raw = CACHE / "raw_pixls_index.json"
    if not raw.exists() and DOWNLOAD:
        import re
        import concurrent.futures as cf
        base = "https://raw.pixls.us/data/"
        row = re.compile(r'<a href="([^"?/][^"]*)">[^<]*</a></td><td[^>]*>[^<]*</td><td[^>]*>\s*([\d.]+[KMG]?|-)\s*</td>')

        def size(s):
            m = {"K": 1e3, "M": 1e6, "G": 1e9}
            return 0 if s == "-" else int(float(s[:-1]) * m[s[-1]]) if s[-1] in m else int(s)

        def ls(path):
            try:
                html = urllib.request.urlopen(base + path, timeout=60).read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                return [], []
            d, f = [], []
            for href, sz in row.findall(html):
                (d.append(path + href) if href.endswith("/") else f.append((path + href, size(sz))))
            return d, f
        files, todo = [], [""]
        with cf.ThreadPoolExecutor(12) as ex:
            for _ in range(3):
                res = list(ex.map(ls, todo))
                todo = []
                for d, f in res:
                    todo += d
                    files += f
        CACHE.mkdir(parents=True, exist_ok=True)
        raw.write_text(json.dumps(files), encoding="utf-8")
    if raw.exists():
        files = json.loads(raw.read_text(encoding="utf-8"))
        best = {}
        for p, s in files:
            e = p.rsplit(".", 1)[-1].lower()
            if e in CATS["image-raw"]["exts"] and 0 < s < 80_000_000 and (e not in best or s < best[e][1]):
                best[e] = (p, s)
        for e, (p, _s) in sorted(best.items()):
            if want("image-raw", e):
                f = dl("https://raw.pixls.us/data/" + p, "rawpixls_" + urllib.request.unquote(p).replace("/", "_").replace(" ", "_"))
                if f:
                    put("image-raw", e, f, "raw.pixls.us " + urllib.request.unquote(p))
    # OpenType CFF e collezione OTC: Source Sans (OFL), la collezione costruita qui con fontTools
    f = dl("https://raw.githubusercontent.com/adobe-fonts/source-sans/release/OTF/SourceSans3-Regular.otf", "SourceSans3-Regular.otf")
    if f:
        put("font", "otf", f, "adobe-fonts/source-sans (OFL)")
        f2 = dl("https://raw.githubusercontent.com/adobe-fonts/source-sans/release/OTF/SourceSans3-Bold.otf", "SourceSans3-Bold.otf")
        if f2 and want("font", "otc"):
            from fontTools.ttLib import TTFont
            from fontTools.ttLib.ttCollection import TTCollection
            c = TTCollection()
            c.fonts = [TTFont(f), TTFont(f2)]
            b = io.BytesIO()
            c.save(b)
            put("font", "otc", b.getvalue(), "derivato da adobe-fonts/source-sans (OFL)")


LO_TEST = "https://raw.githubusercontent.com/LibreOffice/core/master/"
AOO_TEST = "https://raw.githubusercontent.com/apache/openoffice/trunk/main/"
# documenti di prova dei filtri di LibreOffice (writerperfect, hwpfilter, lotuswordpro) e di Apache OpenOffice (qadevOOo):
# file veri dei programmi originali (WordPerfect, Works, Write, CorelDRAW, Hangul, Word Pro, Lotus 1-2-3, StarOffice/OpenOffice 1)
OFFICE_TESTS = [
    ("office-lo", "wpd", LO_TEST + "writerperfect/qa/unit/data/writer/libwpd/pass/WP6.wpd"),
    ("office-lo", "wps", LO_TEST + "writerperfect/qa/unit/data/writer/libwps/pass/Works_4.5.wps"),
    ("office-lo", "wri", LO_TEST + "writerperfect/qa/unit/data/writer/libwps/pass/Write_3.1.wri"),
    ("office-lo", "cdr", LO_TEST + "writerperfect/qa/unit/data/draw/libcdr/pass/fdo65220-2.cdr"),
    ("office-lo", "hwp", LO_TEST + "hwpfilter/qa/cppunit/data/pass/hangul97-3.0.hwp"),
    ("office-lo", "lwp", LO_TEST + "lotuswordpro/qa/cppunit/data/pass/wordpro.lwp"),
    ("office-lo", "abw", LO_TEST + "writerperfect/qa/unit/data/writer/libabw/pass/hello.abw"),
    ("office-lo", "zabw", LO_TEST + "writerperfect/qa/unit/data/writer/libabw/pass/hello.zabw"),
    ("sheet", "wk1", LO_TEST + "writerperfect/qa/unit/data/calc/libwps/pass/Lotus.wk1"),
    ("sheet", "wks", LO_TEST + "writerperfect/qa/unit/data/calc/libwps/pass/Works_Windows.wks"),
    ("office-lo", "sxw", AOO_TEST + "qadevOOo/testdocs/XDocumentInsertable.sxw"),
    ("office-lo", "sxc", AOO_TEST + "qadevOOo/testdocs/Calc_Link.sxc"),
    ("office-lo", "sxd", AOO_TEST + "qadevOOo/testdocs/SvxShape.sxd"),
    ("office-lo", "sxi", AOO_TEST + "qadevOOo/testdocs/TwoShapes.sxi"),
]


def gen_more():
    for cat, ext, url in OFFICE_TESTS:
        if want(cat, ext):
            f = dl(url, ("lo_" if "LibreOffice" in url else "aoo_") + url.rsplit("/", 1)[-1])
            if f:
                put(cat, ext, f, url.split("githubusercontent.com/", 1)[1])
    # ReCap: stesso scrittore del collaudo del lettore (tests/test_rcs.py), struttura ricavata dai file veri
    if want("pointcloud", "rcs") or want("pointcloud", "rcp"):
        sys.path.insert(0, str(ROOT / "tests"))
        try:
            import numpy as np
            from test_rcs import write_rcs
            rng = np.random.default_rng(7)
            vox = [(np.array([10.0 + 2.25 * k, -5.0, 2.0]), 2.25, rng.integers(0, 2251, (1500, 3)), rng.integers(0, 256, (1500, 4)).astype(np.uint8)) for k in range(3)]
            p = dest("pointcloud", "rcs")
            write_rcs(p, vox, translation=(100, 200, 3))
            done.add(("pointcloud", "rcs"))
            items.append({"ext": "rcs", "cat": "pointcloud", "file": str(p.relative_to(OUT)), "fonte": "generato (scrittore di tests/test_rcs.py)"})
            if want("pointcloud", "rcp"):
                sup = dest("pointcloud", "rcp", "campione Support/s1.rcs")
                sup.parent.mkdir(exist_ok=True)
                write_rcs(sup, vox[:2], translation=(100, 200, 3))
                write_rcs(sup.parent / "s2.rcs", vox[2:], translation=(100, 200, 3))
                put("pointcloud", "rcp", '<?xml version="1.0"?><project><scan path="campione Support/s1.rcs"/><scan path="campione Support/s2.rcs"/></project>',
                    "generato (progetto con due scansioni)")
        except Exception as e:  # noqa: BLE001
            print("  RCS non generato:", e)
    # immagini disco ISO 9660 e UDF con il masterizzatore di Windows (IMAPI2, nessun programma in piu')
    if os.name == "nt" and any(want("archive", e) for e in ("iso", "udf", "img")):
        src = tmp("archivio")
        for ext, fs in (("iso", 3), ("udf", 4), ("img", 3)):  # 1 = ISO 9660, 2 = Joliet, 4 = UDF
            if not want("archive", ext):
                continue
            out = tmp(f"disco.{ext}")
            ps = (
                "$fs = New-Object -ComObject IMAPI2FS.MsftFileSystemImage; $fs.FileSystemsToCreate = %d; $fs.VolumeName = 'CAMPIONE';"
                "$fs.Root.AddTree('%s', $false); $img = $fs.CreateResultImage();"
                "Add-Type -TypeDefinition 'using System;using System.IO;using System.Runtime.InteropServices.ComTypes;public static class IsoW{public static void W(object s,string p,int bs,int n){IStream i=(IStream)s;var b=new byte[bs];using(var f=File.Create(p)){for(int k=0;k<n;k++){i.Read(b,bs,IntPtr.Zero);f.Write(b,0,bs);}}}}';"
                "[IsoW]::W($img.ImageStream, '%s', $img.BlockSize, $img.TotalBlocks)") % (fs, str(src).replace("'", "''"), str(out).replace("'", "''"))
            r = run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps])
            if out.exists() and out.stat().st_size > 0:
                put("archive", ext, out, "generato (IMAPI2 di Windows, " + ("UDF" if fs == 4 else "ISO 9660") + ")")
            else:
                print("  immagine disco non generata:", ext, r.stderr.decode("utf-8", "replace")[-200:])
    # VHD "fisso" (specifica Microsoft Virtual Hard Disk): l'immagine ISO come contenuto del disco + piede di 512 byte
    iso = OUT / "archive" / "iso" / "campione.iso"
    if want("archive", "vhd") and iso.exists():
        import time
        import uuid
        data = iso.read_bytes()
        data += b"\0" * (-len(data) % 512)
        size = len(data)
        sectors = size // 512
        cyl, heads, spt = min(sectors // (16 * 63), 65535), 16, 63
        f = bytearray(struct.pack(">8sIIQI4sI4sQQHBBII16sB", b"conectix", 2, 0x00010000, 0xFFFFFFFFFFFFFFFF, int(time.time()) - 946684800,
                                  b"mbd ", 0x00010000, b"Wi2k", size, size, cyl, heads, spt, 2, 0, uuid.uuid4().bytes, 0))
        f += b"\0" * (512 - len(f))
        csum = ~sum(f) & 0xFFFFFFFF  # complemento a uno della somma dei byte, con il campo del checksum a zero
        f[64:68] = struct.pack(">I", csum)
        put("archive", "vhd", data + bytes(f), "generato (VHD fisso con l'immagine ISO)")
    # formula di LibreOffice Math (.odf) prodotta da LibreOffice dal campione MathML (--libreoffice <cartella di soffice.exe>)
    lo = Path(args[args.index("--libreoffice") + 1]) / "soffice.exe" if "--libreoffice" in args else None
    mml = OUT / "office-lo" / "mml" / "campione.mml"
    if lo and lo.exists() and mml.exists() and want("office-lo", "odf"):
        out = tmp("lo")
        out.mkdir(exist_ok=True)
        run([str(lo), "--headless", "--norestore", f"-env:UserInstallation=file:///{(OUT / '_lavoro' / 'lo-profilo').as_posix()}", "--convert-to", "odf", "--outdir", str(out), str(mml)], timeout=180)
        if (out / "campione.odf").exists():
            put("office-lo", "odf", out / "campione.odf", "generato (LibreOffice Math dal campione .mml)")


def gen_fixes():
    """formati ricavati da altri gia' presenti: stesse strutture con un'altra estensione o un altro tipo di contenuto."""
    # Visio: modelli .vstx/.vstm = stesso pacchetto con il tipo "template"
    for ext, src, ct_old, ct_new in (("vstx", SAMPLES / "visio" / "vx_test3_house.vsdx", "drawing.main+xml", "template.main+xml"),
                                     ("vstm", SAMPLES / "visio" / "poi_SimpleMacro.vsdm", "drawing.macroEnabled.main+xml", "template.macroEnabled.main+xml")):
        if want("visio", ext) and src.exists():
            zin = zipfile.ZipFile(src)
            b = io.BytesIO()
            with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
                for i in zin.infolist():
                    d = zin.read(i)
                    if i.filename == "[Content_Types].xml":
                        d = d.replace(ct_old.encode(), ct_new.encode())
                    z.writestr(i, d)
            put("visio", ext, b.getvalue(), "derivato da tests/samples/visio (tipo modello)")
    # fogli Lotus con SheetJS (la libreria che li legge nell'app; .wks = Lotus 1-2-3 v1, intestazione 0x0404)
    if any(want("sheet", e) for e in ("wk1", "wk3", "wks")):
        js = tmp("lotus.cjs")
        js.write_text('const X = require(process.argv[2]); const fs = require("fs");\n'
                      'const ws = X.utils.aoa_to_sheet([["voce", "quantita"], ["scavo", 12], ["muro", 3.5]]); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, "Foglio1");\n'
                      'for (const t of ["wk1", "wk3"]) fs.writeFileSync(process.argv[3] + "/lotus." + t, X.write(wb, { bookType: t, type: "buffer" }));\n', encoding="utf-8")
        r = run(["node", str(js), str(ROOT / "ui" / "vendor" / "xlsx" / "dist" / "xlsx.full.min.js"), str(js.parent)])
        if r.returncode == 0:
            put("sheet", "wk1", js.parent / "lotus.wk1", "generato (SheetJS)")
            put("sheet", "wk3", js.parent / "lotus.wk3", "generato (SheetJS)")
            w = bytearray((js.parent / "lotus.wk1").read_bytes())
            w[4:6] = b"\x04\x04"
            put("sheet", "wks", bytes(w), "generato (SheetJS, versione 1-2-3 v1)")
    put("sheet", "dbf", SAMPLES / "gis" / "province_gaussboaga.dbf", "tests/samples/gis")
    # Parasolid: testo dal NIST (pubblico dominio, .xmt_txt), binario estratto da una parte Solid Edge (flusso PARASOLID/STREAM0.X_B);
    # .p_t/.xmp_txt e .p_b/.xmp_bin sono gli stessi formati con il nome delle "partizioni"
    gh_pick("usnistgov/engineering-design-models", "master", "solidcad", {"xmt_txt": r"PART1/part/part\.xmt_txt$"})
    xt = OUT / "solidcad" / "xmt_txt" / "campione.xmt_txt"
    if xt.exists():
        for ext in ("p_t", "xmp_txt"):
            put("solidcad", ext, xt, "NIST engineering-design-models (Parasolid testo)")
    sc = Path.home() / ".mbvisual" / "solidcad-campioni"
    if sc.exists() and any(want("solidcad", e) for e in ("x_b", "xmt_bin", "p_b", "xmp_bin")):
        import olefile
        for par in sorted(sc.rglob("*.par"), key=lambda f: f.stat().st_size):
            try:
                o = olefile.OleFileIO(str(par))
                st = next(("/".join(e) for e in o.listdir() if e[-1].upper() == "STREAM0.X_B"), None)
                data = o.openstream(st).read() if st else None
                o.close()
            except Exception:  # noqa: BLE001
                data = None
            if data and len(data) > 1000:
                for ext in ("x_b", "xmt_bin", "p_b", "xmp_bin"):
                    put("solidcad", ext, data, f"flusso Parasolid binario di {par.name} (Solid Edge)")
                break
    # OpenXPS (ECMA-388): l'XPS di Word con gli spazi dei nomi di OpenXPS, come fa il convertitore di Microsoft
    xps = OUT / "dwf" / "xps" / "campione.xps"
    if want("dwf", "oxps") and xps.exists():
        zin = zipfile.ZipFile(xps)
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
            for i in zin.infolist():
                d = zin.read(i)
                if i.filename.lower().endswith((".xml", ".rels", ".fdseq", ".fdoc", ".fpage", ".dict")) or i.filename == "[Content_Types].xml":
                    d = d.replace(b"http://schemas.microsoft.com/xps/2005/06", b"http://schemas.openxps.org/oxps/v1.0")
                z.writestr(i, d)
        put("dwf", "oxps", b.getvalue(), "derivato dall'XPS di Word (spazi dei nomi OpenXPS)")
    # Project: un modello .mpt ha la struttura di un .mpp
    pc = Path.home() / ".mbvisual" / "project-campioni"
    mpp_ok = OUT / "project" / "mpp" / "campione.mpp"
    if want("project", "mpt") and mpp_ok.exists():
        put("project", "mpt", mpp_ok, "project-campioni (stessa struttura di un .mpp)")
    # NetCDF-4 = HDF5
    put("scidata", "nc4", SAMPLES / "fx" / "misure.h5", "tests/samples/fx (NetCDF-4 e' un file HDF5)")
    # PFM scritto a mano (Pillow non lo salva)
    if want("image", "pfm"):
        import array
        w, h = 64, 48
        a = array.array("f", [((x ^ y) & 31) / 31.0 for y in range(h) for x in range(w) for _c in range(3)])
        put("image", "pfm", f"PF\n{w} {h}\n-1.0\n".encode() + a.tobytes(), "generato")
    # archivi divisi in volumi e OVA
    src = tmp("archivio")
    if want("archive", "001") and src.exists():
        out = tmp("volumi.7z")
        for f in out.parent.glob("volumi.7z*"):
            f.unlink()
        big = src / "riempitivo.bin"
        big.write_bytes(os.urandom(150_000))
        run([SZ, "a", "-t7z", "-v100k", str(out), str(src / "*")])
        big.unlink()
        if (out.parent / "volumi.7z.001").exists():
            p = put("archive", "001", out.parent / "volumi.7z.001", "generato (7-Zip, volumi)", name="campione.7z.001")
            for f in out.parent.glob("volumi.7z.0*"):
                if f.suffix != ".001":
                    shutil.copyfile(f, p.parent / ("campione.7z" + f.suffix))
    if want("archive", "ova"):
        import tarfile
        b = io.BytesIO()
        with tarfile.open(fileobj=b, mode="w") as t:
            for n, d in (("macchina.ovf", b'<?xml version="1.0"?><Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1"/>\n'), ("macchina.mf", b"SHA256(macchina.ovf)= 00\n")):
                ti = tarfile.TarInfo(n)
                ti.size = len(d)
                t.addfile(ti, io.BytesIO(d))
        put("archive", "ova", b.getvalue(), "generato")
    # pacchetti di Windows presenti nel sistema (MSI/MSP/CHM): solo lettura, copie locali per la prova
    win = Path(os.environ.get("WINDIR", "C:/Windows"))
    for ext, globs in (("msi", [win / "Installer"]), ("msp", [win / "Installer"]), ("chm", [win / "Help", win / "hh"])):
        if not want("archive", ext):
            continue
        try:
            c = sorted((p for g in globs if g.exists() for p in g.rglob("*." + ext) if 0 < p.stat().st_size < 20_000_000), key=lambda p: p.stat().st_size)
        except OSError:
            c = []
        if c:
            put("archive", ext, c[0], "Windows (copia locale)")
    # dv/dif/y4m/mj2: impostazioni giuste per FFmpeg
    ffgen("media", "dv", ["-c:v", "dvvideo", "-s", "720x576", "-pix_fmt", "yuv420p", "-r", "25", "-ar", "48000", "-ac", "2"], True)
    ffgen("media", "dif", ["-f", "dv", "-c:v", "dvvideo", "-s", "720x576", "-pix_fmt", "yuv420p", "-r", "25", "-ar", "48000", "-ac", "2"], True)
    ffgen("media", "y4m", ["-map", "0:v", "-pix_fmt", "yuv420p", "-f", "yuv4mpegpipe"], True)
    ffgen("media", "mj2", ["-map", "0:v", "-c:v", "jpeg2000", "-pix_fmt", "yuv420p", "-f", "mj2"], True)
    ffgen("audio", "truehd", ["-f", "truehd", "-ar", "48000", "-strict", "-2"], False)
    ffgen("audio", "g723_1", ["-ar", "8000", "-ac", "1", "-c:a", "g723_1", "-b:a", "6300", "-f", "g723_1"], False)
    ffgen("audio", "daud", ["-ar", "96000", "-ac", "6", "-c:a", "pcm_s24daud", "-f", "daud"], False)  # D-Cinema: sempre 6 canali
    # VVC (H.266) grezzo: stesso flusso con le tre estensioni
    vvc = OUT / "media" / "vvc" / "campione.vvc"
    if vvc.exists():
        for ext in ("266", "h266"):
            put("media", ext, vvc, "fate-suite (flusso VVC)")


def gen_creo():
    """Creo Parametric: esempi del progetto creo2urdf (BSD-3-Clause), con il numero di versione nel nome come li salva Creo."""
    base = "https://raw.githubusercontent.com/mesh-iit/creo2urdf/master/examples/2bars/"
    for ext, name in (("prt", "bar.prt.1"), ("asm", "2bars_pin.asm.1")):
        if want("creo", ext):
            f = dl(base + name, "creo2urdf_" + name)
            if f:
                put("creo", ext, f, "creo2urdf examples/2bars/" + name, name=f"campione.{ext}.1")
    loc = Path.home() / ".mbvisual" / "creo-campioni"  # altri file Creo veri, se scaricati a parte (disegni, formati)
    for ext in ("drw", "frm", "prt", "asm"):
        if want("creo", ext) and loc.exists():
            c = sorted(loc.rglob(f"*.{ext}.*"), key=lambda p: p.stat().st_size)
            if c:
                put("creo", ext, c[0], "creo-campioni", name=f"campione.{ext}.1")


def gen_extra():
    """campioni delle altre sessioni (%USERPROFILE%/.mbvisual e %TEMP%): solo come ultima scelta."""
    roots = EXTRA or []
    home = Path.home() / ".mbvisual"
    roots += [home / d for d in ("dwg3d-campioni", "ipt-campioni", "step-prove", "ifc-step-campioni")]
    roots += [Path(os.environ.get("TEMP", "")) / d for d in ("skp-campioni",)]
    for cat, c in CATS.items():
        for ext in c["exts"]:
            if not want(cat, ext):
                continue
            for r in roots:
                if not r.exists():
                    continue
                lo = {"skp": 100_000}.get(ext, 0)  # gli .skp piu' piccoli sono file "legacy" che il lettore non apre
                cands = sorted((p for p in r.rglob("*." + ext) if lo < p.stat().st_size < 60_000_000), key=lambda p: p.stat().st_size)
                if cands:
                    put(cat, ext, cands[0], str(r.name))
                    break


RAW_ACCEPT = {("audio", e) for e in ("pcm", "s16le", "sw", "ub", "uw", "sln", "alaw", "ulaw", "al", "ul")} | {("media", "yuv")}


def gen_reuse():
    """campioni fatti da Office via COM in un giro precedente (Office a volte si scollega e blocca il giro: 0x80010108)."""
    if not REUSE or not (REUSE / "manifest.json").exists():
        return
    for it in json.loads((REUSE / "manifest.json").read_text(encoding="utf-8"))["items"]:
        if any(k in it.get("fonte", "") for k in ("(Word)", "(Excel)", "(PowerPoint)", "(Publisher)")) and want(it["cat"], it["ext"]):
            put(it["cat"], it["ext"], REUSE / it["file"], it["fonte"])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for step in (gen_reuse, gen_repo, gen_text, gen_images, gen_media, gen_trackers, gen_archives, gen_office, gen_opendoc_flat, gen_signed_cert,
                 gen_cad_3d, gen_project, gen_creo, gen_more, gen_public, gen_fixes, gen_fate, gen_fixes, gen_extra):
        print("--", step.__name__)
        try:
            step()
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            print("  passo non riuscito:", step.__name__, e)
    for cat, c in CATS.items():
        for ext in c["exts"]:
            if (cat, ext) not in done and (not ONLY or ext in ONLY):
                if not reachable(cat, ext):
                    continue
                missing.append({"ext": ext, "cat": cat, "motivo": "nessun campione"})
    for it in items:  # file grezzi: il collaudo conferma la finestra dei parametri con i valori proposti
        if (it["cat"], it["ext"]) in RAW_ACCEPT:
            it["accept"] = True
    old = OUT / "manifest.json"
    if ONLY and old.exists():  # giro parziale: si tengono le voci delle altre estensioni del giro precedente
        prev = json.loads(old.read_text(encoding="utf-8"))
        items[:0] = [it for it in prev["items"] if it["ext"] not in ONLY]
        missing[:0] = [m for m in prev.get("senza", []) if m["ext"] not in ONLY]
    (OUT / "manifest.json").write_text(json.dumps({"items": items, "senza": missing}, indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "FONTI.md").write_text("# Fonti dei campioni scaricati (solo per le prove, non ridistribuire)\n\n" + "".join(f"- {u}\n" for u in sorted(sources)), encoding="utf-8")
    print(f"{len(items)} campioni, {len(missing)} coppie senza campione:")
    print(" ".join(f"{m['cat']}:{m['ext']}" for m in missing))


if __name__ == "__main__":
    main()
