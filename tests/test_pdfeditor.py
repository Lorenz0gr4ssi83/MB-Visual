"""Collaudo del motore dell'editor PDF (mbvisual/pdfobjects.py + pdfdoc.py) senza interfaccia.

    python tests/test_pdfeditor.py [cartella_con_pdf_reali]

Crea un PDF di prova con testi (carattere incorporato), immagini, disegni vettoriali, campi e una pagina ruotata;
applica ogni operazione su una copia e controlla il risultato leggendo il PDF (testi, immagini, tracciati, pixel).
Con una cartella di PDF reali: legge gli oggetti di ogni prima pagina e prova sposta/ruota/aspetto/copia sugli oggetti trovati.
"""
import base64
import io
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pymupdf  # noqa: E402

from mbvisual import pdfedit, pdfobjects  # noqa: E402
from mbvisual.pdfedit import _to_pdf  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="mbv-pdfed-"))
OK, KO = [], []


def check(name, cond, extra=""):
    (OK if cond else KO).append(name)
    print(("OK  " if cond else "ERR ") + name + (f"  ({extra})" if extra and not cond else ""))


def png(color=(220, 40, 40), size=(120, 80), white_border=True):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", size, (255, 255, 255) if white_border else color)
    ImageDraw.Draw(im).rectangle([20, 15, size[0] - 20, size[1] - 15], fill=color)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def make_sample(path):
    doc = pymupdf.open()
    p = doc.new_page(width=595, height=842)
    arial = pymupdf.Font(fontfile=r"C:\Windows\Fonts\arial.ttf")
    tw = pymupdf.TextWriter(p.rect)
    tw.append((60, 95), "Relazione tecnica di collaudo", font=arial, fontsize=14)
    tw.append((60, 112), "seconda riga del paragrafo", font=arial, fontsize=14)
    tw.write_text(p)
    doc.subset_fonts()
    pdfedit.fix_tounicode(doc)
    p.insert_text((60, 400), "Mario Rossi codice RSSMRA80A01H501U", fontname="helv", fontsize=11)
    p.insert_image(pymupdf.Rect(300, 200, 420, 280), stream=png())
    sh = p.new_shape()
    sh.draw_rect(pymupdf.Rect(60, 500, 200, 600))
    sh.finish(color=(0, 0, 1), fill=(0.9, 0.9, 1), width=2)
    sh.draw_line((60, 650), (250, 650))
    sh.finish(color=(0, 0.5, 0), width=1)
    sh.commit()
    p2 = doc.new_page(width=595, height=842)
    p2.insert_text((60, 100), "Pagina due", fontname="helv", fontsize=12)
    p3 = doc.new_page(width=595, height=842)
    p3.insert_text((60, 100), "Pagina tre ruotata", fontname="helv", fontsize=12)
    p3.set_rotation(90)
    doc.save(path)


def objs(path, pno=0):
    return pdfobjects.page_objects(path, pno)


def work(src, name):
    dst = TMP / name
    shutil.copyfile(src, dst)
    return str(dst)


def run(path, ops):
    return pdfobjects.apply_ops(path, ops)


def pixel(path, pno, x, y, dpi=72):
    """Colore del pixel nel punto (x, y) in coordinate visibili (punti)."""
    with pymupdf.open(path) as d:
        pix = d[pno].get_pixmap(dpi=dpi)
        k = dpi / 72
        return pix.pixel(int(x * k), int(y * k))


def ink_box(path, pno, region, dpi=72):
    """Riquadro (coordinate visibili, punti) dei pixel scuri dentro region = (x0, y0, x1, y1)."""
    with pymupdf.open(path) as d:
        pix = d[pno].get_pixmap(dpi=dpi)
    k = dpi / 72
    xs, ys = [], []
    for y in range(int(region[1] * k), min(pix.height, int(region[3] * k))):
        for x in range(int(region[0] * k), min(pix.width, int(region[2] * k))):
            if sum(pix.pixel(x, y)[:3]) < 300:
                xs.append(x)
                ys.append(y)
    return (min(xs) / k, min(ys) / k, max(xs) / k, max(ys) / k) if xs else None


def test_synthetic():
    src = str(TMP / "campione.pdf")
    make_sample(src)
    d = objs(src)
    kinds = {o["kind"] for o in d["oggetti"]}
    check("oggetti: testo, immagine, gruppo", {"text", "image", "group"} <= kinds, kinds)
    text = next(o for o in d["oggetti"] if o["kind"] == "text" and "Relazione" in o["text"])
    check("testo: carattere incorporato riconosciuto", text["embedded"], text)
    check("testo: interlinea letta", 1.0 <= text["lineheight"] <= 1.6, text["lineheight"])
    check("colori del documento (campioni)", len(d["colori"]) >= 2, d["colori"])

    # ---- testo esistente: riscrittura con il carattere incorporato, interlinea, colore, rotazione
    w = work(src, "testo.pdf")
    run(w, [{"kind": "text_block", "page": 0, "box": text["box"], "text": "Relazione aggiornata\nriga due\nriga tre", "font": text["font"],
             "size": 14, "color": "#1565c0", "lineheight": 1.5}])
    with pymupdf.open(w) as dd:
        t = dd[0].get_text()
        fonts = [f[3] for f in dd[0].get_fonts()]
        spans = [s for b in dd[0].get_text("dict")["blocks"] for ln in b.get("lines", []) for s in ln["spans"] if "aggiornata" in s["text"]]
    check("testo: riscritto", "Relazione aggiornata" in t and "Relazione tecnica" not in t, t[:80])
    check("testo: stesso carattere (Arial incorporato)", any("Arial" in f for f in fonts), fonts)
    check("testo: colore", spans and pdfobjects._hex(spans[0]["color"]) == "#1565c0", spans[:1])
    w = work(src, "testo_ruotato.pdf")
    run(w, [{"kind": "text_block", "page": 0, "box": text["box"], "text": "Ruotato", "font": text["font"], "size": 14, "rotate_obj": 90}])
    with pymupdf.open(w) as dd:
        dirs = [ln["dir"] for b in dd[0].get_text("dict")["blocks"] for ln in b.get("lines", []) if "Ruotato" in "".join(s["text"] for s in ln["spans"])]
    check("testo: ruotato di 90 gradi", dirs and abs(dirs[0][0]) < 0.01 and dirs[0][1] > 0.99, dirs)

    # ---- immagini
    img = next(o for o in d["oggetti"] if o["kind"] == "image")
    w = work(src, "img_sposta.pdf")
    b = img["box"]
    to = [b[0] + 100, b[1] - 50, b[2] + 100, b[3] - 50]
    run(w, [{"kind": "image_move", "page": 0, "xref": img["xref"], "box": b, "to": to}])
    i2 = [o for o in objs(w)["oggetti"] if o["kind"] == "image"]
    check("immagine: spostata", len(i2) == 1 and all(abs(x - y) < 1 for x, y in zip(i2[0]["box"], to)), i2)
    w = work(src, "img_ruota.pdf")
    run(w, [{"kind": "image_move", "page": 0, "xref": img["xref"], "box": b, "rotate_obj": 30}])
    i2 = [o for o in objs(w)["oggetti"] if o["kind"] == "image"]
    check("immagine: ruotata 30 gradi (riquadro piu' grande)", i2 and (i2[0]["box"][3] - i2[0]["box"][1]) > (b[3] - b[1]) + 20, i2)
    w = work(src, "img_trasp.pdf")
    run(w, [{"kind": "image_edit", "page": 0, "xref": img["xref"], "box": b, "transparent": ["#ffffff"], "tol": 10}])
    # bordo bianco dell'immagine diventato trasparente: sotto c'e' la pagina bianca, si controlla l'alfa nell'immagine
    with pymupdf.open(w) as dd:
        x = dd[0].get_images()[0][0]
        pm = pymupdf.Pixmap(dd, x)
        sm = dd.extract_image(x).get("smask")
    check("immagine: colore trasparente (maschera)", bool(sm), sm)
    # un'immagine con trasparenza spostata e ruotata deve restare trasparente (prima diventava un rettangolo nero)
    it = next(o for o in objs(w)["oggetti"] if o["kind"] == "image")
    run(w, [{"kind": "image_move", "page": 0, "xref": it["xref"], "box": it["box"], "rotate_obj": 15}])
    with pymupdf.open(w) as dd:
        x = dd[0].get_images()[0][0]
        sm = dd.extract_image(x).get("smask")
    px = pixel(w, 0, 302, 205)  # angolo del riquadro dell'immagine ruotata: bordo bianco reso trasparente -> pagina bianca
    check("immagine trasparente spostata e ruotata: trasparenza conservata", bool(sm) and px[0] > 240 and px[1] > 240, (sm, px))
    # maschera di stencil (logo a 1 bit): spostata resta un logo, non un rettangolo pieno
    ws = str(TMP / "stencil.pdf")
    # PDF scritto a mano: maschera di stencil 80x40 a 1 bit, meta' sinistra dipinta in blu (0 = si dipinge)
    mask = (b"\x00" * 5 + b"\xff" * 5) * 40
    content = b"q 0 0 1 rg 80 0 0 40 50 60 cm /Im1 Do Q"
    objs_ = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
             b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
             b"<< /Type /XObject /Subtype /Image /Width 80 /Height 40 /ImageMask true /BitsPerComponent 1 /Length %d >>\nstream\n" % len(mask) + mask + b"\nendstream",
             b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"]
    raw = io.BytesIO()
    raw.write(b"%PDF-1.4\n")
    offs = []
    for i, ob in enumerate(objs_, 1):
        offs.append(raw.tell())
        raw.write(b"%d 0 obj\n" % i + ob + b"\nendobj\n")
    xr = raw.tell()
    raw.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs_) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs))
    raw.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF" % (len(objs_) + 1, xr))
    Path(ws).write_bytes(raw.getvalue())
    st = [o for o in objs(ws)["oggetti"] if o["kind"] == "image"]
    if st:
        run(ws, [{"kind": "image_move", "page": 0, "xref": st[0]["xref"], "box": st[0]["box"], "to": [st[0]["box"][0] + 100, st[0]["box"][1], st[0]["box"][2] + 100, st[0]["box"][3]]}])
        pa, pb = pixel(ws, 0, 160, 120), pixel(ws, 0, 210, 120)
        check("maschera di stencil spostata: stesso colore (blu) e trasparente dove non dipinge", pa[2] > 200 and pa[0] < 60 and pb[0] > 240, (pa, pb))
    else:
        check("maschera di stencil letta", False, "nessuna immagine")
    w = work(src, "img_ritaglio.pdf")
    run(w, [{"kind": "image_edit", "page": 0, "xref": img["xref"], "box": b, "crop": [0.25, 0, 0.25, 0], "brightness": 20, "contrast": 10}])
    i2 = [o for o in objs(w)["oggetti"] if o["kind"] == "image"]
    check("immagine: ritaglio (meta' larghezza)", i2 and abs((i2[0]["box"][2] - i2[0]["box"][0]) - (b[2] - b[0]) / 2) < 1.5 and i2[0]["px"][0] == 60, i2)
    w = work(src, "img_specchio.pdf")
    run(w, [{"kind": "image_edit", "page": 0, "xref": img["xref"], "box": b, "flip_h": True, "opacity": 0.5, "gray": True}])
    check("immagine: specchio + opacita' + grigi", len([o for o in objs(w)["oggetti"] if o["kind"] == "image"]) == 1)
    out = str(TMP / "esportata.png")
    pdfobjects.image_export(src, 0, img["xref"], b, out)
    from PIL import Image
    check("immagine: esporta PNG", Image.open(out).size == (120, 80))
    out = str(TMP / "esportata.jpg")
    pdfobjects.image_export(src, 0, img["xref"], b, out)
    check("immagine: esporta JPG", Image.open(out).format == "JPEG")
    w = work(src, "img_sost.pdf")
    run(w, [{"kind": "image_replace", "page": 0, "xref": img["xref"], "box": b, "data": base64.b64encode(png((20, 160, 60))).decode()}])
    check("immagine: sostituita (verde al centro)", pixel(w, 0, 360, 240)[1] > 120 and pixel(w, 0, 360, 240)[0] < 80, pixel(w, 0, 360, 240))

    # ---- disegni vettoriali
    grp = next(o for o in d["oggetti"] if o["kind"] == "group" and o.get("fill"))
    w = work(src, "vett_stile.pdf")
    run(w, [{"kind": "draw_edit", "page": 0, "box": grp["box"], "style": {"stroke": "#ff0000", "fill": "cmyk(0,100,100,0)", "width": 4, "dash": "dash"}}])
    dr = pymupdf.open(w)[0].get_drawings()
    fl = [x for x in dr if x.get("fill")]
    st = [x for x in dr if x.get("color") and x["color"][0] > 0.9]
    check("vettoriale: colore, riempimento CMYK, spessore, tratteggio", fl and st and st[0]["width"] == 4 and st[0]["dashes"] not in ("[] 0", None)
          and fl[0]["fill"][0] > 0.9 and fl[0]["fill"][1] < 0.2, dr)
    w = work(src, "vett_ruota.pdf")
    run(w, [{"kind": "draw_move", "page": 0, "box": grp["box"], "rotate_obj": 90}])
    dr = [x for x in pymupdf.open(w)[0].get_drawings() if x.get("fill")]
    check("vettoriale: ruotato 90 gradi (140x100 -> 100x140)", dr and abs(dr[0]["rect"].width - 100) < 3 and abs(dr[0]["rect"].height - 140) < 3, dr[:1] and dr[0]["rect"])
    w = work(src, "vett_copia.pdf")
    run(w, [{"kind": "obj_copy", "page": 0, "obj": "group", "box": grp["box"], "to_page": 1, "to": grp["box"]},
            {"kind": "obj_copy", "page": 0, "obj": "image", "xref": img["xref"], "box": b, "to_page": 1, "to": b},
            {"kind": "obj_copy", "page": 0, "obj": "text", "box": text["box"], "to_page": 1, "to": text["box"], "text": text["text"], "font": text["font"], "size": text["size"]}])
    p1 = objs(w, 1)
    check("copia su un'altra pagina: disegno, immagine, testo", any(o["kind"] == "group" for o in p1["oggetti"]) and any(o["kind"] == "image" for o in p1["oggetti"])
          and "Relazione tecnica" in pymupdf.open(w)[1].get_text(), [o["kind"] for o in p1["oggetti"]])
    w = work(src, "vett_ordine.pdf")
    run(w, [{"kind": "obj_order", "page": 0, "obj": "image", "xref": img["xref"], "box": b, "where": "back"},
            {"kind": "background", "pages": [0], "color": "#ffffff"}])
    check("ordine: immagine in fondo (coperta dallo sfondo bianco sotto?)", pixel(w, 0, 360, 240)[0] > 150, pixel(w, 0, 360, 240))
    # tavole troppo dense per elencare i tracciati: ricerca per punto (clic su un tratto) e per riquadro
    h = pdfobjects.paths_hit(src, 0, point=[150, 842 - 650])  # linea verde orizzontale a y=650 (60..250)
    check("tracciato sotto il clic", h["tracciati"] and h["tracciati"][0]["stroke"] == "#008000", h["tracciati"][:1])
    h = pdfobjects.paths_hit(src, 0, box=[50, 842 - 610, 210, 842 - 490])
    check("tracciati nel riquadro come gruppo", h["gruppo"] and h["gruppo"]["n"] >= 1, h)
    w = work(src, "vett_elimina.pdf")
    run(w, [{"kind": "draw_delete", "page": 0, "box": grp["box"]}])
    check("vettoriale: eliminato", not any(x.get("fill") for x in pymupdf.open(w)[0].get_drawings()))

    # ---- commenti
    w = work(src, "commenti.pdf")
    tb = [o for o in d["oggetti"] if o["kind"] == "text" and "Mario" in o["text"]][0]["box"]
    run(w, [{"kind": "annot_add", "page": 0, "type": "highlight", "box": tb, "color": "#ffeb3b", "author": "Lorenzo"},
            {"kind": "annot_add", "page": 0, "type": "note", "box": [500, 700, 520, 720], "text": "Verificare quota", "author": "Lorenzo"},
            {"kind": "annot_add", "page": 0, "type": "cloud", "box": [300, 300, 450, 380], "color": "#d32f2f"},
            {"kind": "annot_add", "page": 0, "type": "arrow", "p1": [100, 300], "p2": [200, 350], "color": "#1565c0"},
            {"kind": "annot_add", "page": 0, "type": "freetext", "box": [100, 200, 260, 240], "text": "Nota libera", "fill": "#fff8c4"},
            {"kind": "annot_add", "page": 0, "type": "stamp", "box": [380, 720, 560, 790], "text": "Approvato", "sub": "Lorenzo 22/10/2026", "color": "#2e7d32"},
            {"kind": "annot_add", "page": 0, "type": "rect", "box": [60, 60, 120, 90], "color": "#000000"},
            {"kind": "annot_add", "page": 0, "type": "ellipse", "box": [60, 60, 120, 90], "color": "#000000"}])
    lst = pdfobjects.annots_list(w)["commenti"]
    types = sorted({c["type"] for c in lst})
    check("commenti: 8 tipi creati", len(lst) == 8, types)
    note = next(c for c in lst if c["type"] == "Text")
    run(w, [{"kind": "annot_reply", "page": 0, "xref": note["xref"], "text": "Fatto", "author": "Paolo"},
            {"kind": "annot_state", "page": 0, "xref": note["xref"], "state": "Accepted", "author": "Paolo"}])
    lst = pdfobjects.annots_list(w)["commenti"]
    note = next(c for c in lst if c["type"] == "Text")
    check("commenti: risposta e stato", len(note["replies"]) == 1 and note["replies"][0]["contents"] == "Fatto" and note["state"] == "Accepted", note)
    hl = next(c for c in lst if c["type"] == "Highlight")
    check("commenti: testo evidenziato citato", "Mario" in hl.get("quote", ""), hl)
    run(w, [{"kind": "annot_update", "page": 0, "xref": note["xref"], "props": {"contents": "Verificare quota 2", "stroke": "#00ff00"}},
            {"kind": "annot_delete", "page": 0, "xref": next(c for c in lst if c["type"] == "Square")["xref"]}])
    lst = pdfobjects.annots_list(w)["commenti"]
    check("commenti: modifica ed eliminazione", len(lst) == 7 and next(c for c in lst if c["type"] == "Text")["contents"] == "Verificare quota 2", len(lst))
    run(w, [{"kind": "annot_delete", "page": 0, "xref": note["xref"]}])
    with pymupdf.open(w) as dd:
        left = [a for a in dd[0].annots() if a.irt_xref]
    check("commenti: eliminando il commento spariscono risposte e stato", not left, left)

    # ---- oscuramento: segna da ricerca, poi applica
    w = work(src, "oscura.pdf")
    r = run(w, [{"kind": "redact_search", "terms": ["Mario Rossi"]}, {"kind": "redact_search", "terms": [r"[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]"], "regex": True}])
    check("oscura: occorrenze trovate (nome + codice fiscale)", r.get("trovati") == 2, r)
    lst = pdfobjects.annots_list(w)["commenti"]
    check("oscura: segnati come Redact", sum(1 for c in lst if c["type"] == "Redact") == 2, [c["type"] for c in lst])
    run(w, [{"kind": "redact_apply"}])
    t = pymupdf.open(w)[0].get_text()
    check("oscura: testo eliminato davvero", "Mario" not in t and "RSSMRA" not in t and "codice" in t, t)

    # ---- documento: intestazioni, Bates, filigrana, sfondo
    w = work(src, "documento.pdf")
    run(w, [{"kind": "header_footer", "items": {"tc": "Commessa 1399", "br": "Pagina {n} di {tot}"}, "size": 9},
            {"kind": "bates", "prefix": "MBV-", "start": 7, "digits": 5, "pos": "bl"},
            {"kind": "watermark", "text": "BOZZA", "opacity": 0.3, "angle": 45},
            {"kind": "background", "pages": "2", "color": "#ffeecc"}])
    with pymupdf.open(w) as dd:
        t0, t2 = dd[0].get_text(), dd[2].get_text()
        hb = [b for b in dd[2].get_text("blocks") if "Commessa" in b[4]]
        vr = dd[2].rect
    check("intestazione e pie' di pagina con numeri", "Commessa 1399" in t0 and "Pagina 1 di 3" in t0 and "Pagina 3 di 3" in t2, t0[-120:])
    check("Bates", "MBV-00007" in t0 and "MBV-00009" in t2, t2)
    check("filigrana", "BOZZA" in t0.replace("\n", ""), t0)
    # pagina 3 ruotata: l'intestazione deve stare in alto nella pagina come si vede (rect visibile)
    ink = ink_box(w, 2, (0, 0, vr.width - 60, 60))
    check("pagina ruotata: intestazione in alto al centro, orizzontale", ink and abs((ink[0] + ink[2]) / 2 - vr.width / 2) < 30 and ink[3] - ink[1] < 14, ink)
    ink = ink_box(w, 2, (vr.width / 2, vr.height - 40, vr.width, vr.height))
    check("pagina ruotata: pie' di pagina in basso a destra", ink and ink[2] > vr.width - 60, ink)

    # ---- pagina ruotata: paragrafo riscritto e macchina da scrivere restano dritti come si vedono
    w2 = work(src, "ruotata_testo.pdf")
    t3 = next(o for o in objs(w2, 2)["oggetti"] if o["kind"] == "text")
    # il testo originale della pagina 3 e' stato scritto prima di ruotare la pagina: sullo schermo e' verticale e deve
    # restare verticale; la macchina da scrivere invece scrive dritto rispetto alla pagina come si vede
    run(w2, [{"kind": "text_block", "page": 2, "box": t3["box"], "text": "Pagina tre corretta", "font": t3["font"], "size": t3["size"], "dir": t3["dir"]},
             {"kind": "typewriter", "page": 2, "at": [100, 100], "text": "Scritta a macchina", "size": 12}])
    with pymupdf.open(w2) as dd:
        dirs = {"".join(s["text"] for s in ln["spans"]): ln["dir"] for b in dd[2].get_text("dict")["blocks"] for ln in b.get("lines", [])}
    d0 = [v for txt, v in dirs.items() if "corretta" in txt]
    d1 = [v for txt, v in dirs.items() if "macchina" in txt]
    check("pagina ruotata: testo riscritto con lo stesso verso dell'originale", d0 and abs(d0[0][0] - t3["dir"][0]) < 0.01 and abs(d0[0][1] - t3["dir"][1]) < 0.01, (dirs, t3["dir"]))
    check("pagina ruotata: macchina da scrivere dritta", d1 and abs(d1[0][1] + 1) < 0.01, dirs)
    px = pixel(w, 1, 300, 300)
    check("sfondo colorato sulla pagina 2", px[0] > 240 and 220 < px[1] < 245 and px[2] < 215, px)
    w = work(src, "filigrana_img.pdf")
    run(w, [{"kind": "watermark", "image": base64.b64encode(png((0, 0, 200))).decode(), "opacity": 0.5, "behind": False, "scale": 40}])
    px = pixel(w, 0, 297, 421)
    check("filigrana immagine semitrasparente al centro", 100 < px[0] < 160 and px[2] > 200, px)

    # ---- pagine
    w = work(src, "pagine.pdf")
    run(w, [{"kind": "page_order", "order": [2, 0, 1]}])
    check("pagine: riordino", "ruotata" in pymupdf.open(w)[0].get_text())
    run(w, [{"kind": "page_duplicate", "pages": [0]}, {"kind": "page_rotate", "pages": [1, 2], "angle": 90}, {"kind": "page_blank", "at": 4}])
    with pymupdf.open(w) as dd:
        n, rots = len(dd), [p.rotation for p in dd]
    check("pagine: duplica, ruota, bianca", n == 5 and rots[:3] == [90, 180, 90], (n, rots))
    run(w, [{"kind": "page_delete", "pages": [4, 1]}])
    check("pagine: elimina piu' pagine", len(pymupdf.open(w)) == 3)
    run(w, [{"kind": "page_replace", "pages": [2], "file": src, "from_pages": "1"}, {"kind": "page_insert_pdf", "at": 0, "file": src, "from_pages": "2-3"}])
    with pymupdf.open(w) as dd:
        texts = [p.get_text() for p in dd]
    check("pagine: inserisci da file e sostituisci", len(texts) == 5 and "Pagina due" in texts[0] and "Relazione tecnica" in texts[4], [t[:20] for t in texts])
    run(w, [{"kind": "crop", "pages": [4], "margins": [10, 10, 10, 10]}])
    with pymupdf.open(w) as dd:
        cr = dd[4].rect
    check("pagine: ritaglio margini 10 mm", abs(cr.width - (595 - 2 * 10 * 72 / 25.4)) < 1, cr)
    run(w, [{"kind": "crop", "pages": [4], "reset": True}])
    check("pagine: ritaglio annullato", abs(pymupdf.open(w)[4].rect.width - 595) < 0.5)

    # ---- moduli
    w = work(src, "moduli.pdf")
    run(w, [{"kind": "field_add", "page": 0, "box": [60, 700, 260, 720], "type": "text", "name": "nome", "required": True, "bg": "#eef4ff", "maxlen": 20},
            {"kind": "field_add", "page": 0, "box": [60, 660, 260, 680], "type": "combo", "name": "scelta", "options": ["A", "B"]},
            {"kind": "field_add", "page": 0, "box": [60, 630, 74, 644], "type": "check", "name": "ok"}])
    fl = [o for o in objs(w)["oggetti"] if o["kind"] == "field"]
    check("moduli: 3 campi creati", len(fl) == 3 and any(f["required"] and f["maxlen"] == 20 for f in fl), [(f["name"], f["type"]) for f in fl])
    f = next(f for f in fl if f["name"] == "nome")
    run(w, [{"kind": "field_update", "page": 0, "xref": f["xref"], "props": {"name": "cognome", "value": "Rossi", "readonly": True}}])
    f = next(f for f in objs(w)["oggetti"] if f["kind"] == "field" and f["type"] == "text")
    check("moduli: campo modificato", f["name"] == "cognome" and f["value"] == "Rossi" and f["readonly"], f)


def test_real(folder):
    for f in sorted(Path(folder).glob("*.pdf")):
        try:
            d = objs(str(f))
            kinds = {}
            for o in d["oggetti"]:
                kinds[o["kind"]] = kinds.get(o["kind"], 0) + 1
            check(f"reale {f.name}: oggetti letti", True)
            w = work(str(f), "reale_" + f.name)
            ops = []
            # immagini con maschera (loghi trasparenti): spostate devono restare trasparenti
            with pymupdf.open(str(f)) as dd:
                masked = {x[0] for x in dd[0].get_images(full=True) if x[1]}
            mimg = next((o for o in d["oggetti"] if o["kind"] == "image" and o["xref"] in masked), None)
            if mimg:
                wm = work(str(f), "reale_maschera_" + f.name)
                b = mimg["box"]
                run(wm, [{"kind": "image_move", "page": 0, "xref": mimg["xref"], "box": b, "to": [b[0] + 3, b[1], b[2] + 3, b[3]]}])
                with pymupdf.open(wm) as dd:
                    hit = [i for i in dd[0].get_image_info(xrefs=True) if abs(i["bbox"][0] - (b[0] + 3)) < 1.5]
                    sm = dd.extract_image(hit[0]["xref"]).get("smask") if hit else 0
                    ok = bool(sm) and min(pymupdf.Pixmap(dd, sm).samples) < 128  # maschera con parti davvero trasparenti
                check(f"reale {f.name}: immagine con maschera spostata resta trasparente", ok, hit)
            img = next((o for o in d["oggetti"] if o["kind"] == "image" and not o.get("shared")), None)
            if img:
                b = img["box"]
                ops.append({"kind": "image_move", "page": 0, "xref": img["xref"], "box": b, "to": [b[0] + 5, b[1] + 5, b[2] + 5, b[3] + 5]})
            grp = next((o for o in d["oggetti"] if o["kind"] == "group"), None)
            if grp:
                ops.append({"kind": "draw_edit", "page": 0, "box": grp["box"], "style": {"stroke": "#ff0000"}})
            txt = next((o for o in d["oggetti"] if o["kind"] == "text"), None)
            if txt:
                ops.append({"kind": "text_block", "page": 0, "box": txt["box"], "text": txt["text"] + " (mod)", "font": txt["font"], "size": txt["size"], "color": txt["color"]})
            if ops:
                run(w, ops)
                t = pymupdf.open(w)[0].get_text()
                check(f"reale {f.name}: modifiche applicate {kinds}", not txt or "(mod)" in t)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            check(f"reale {f.name}", False, e)


if __name__ == "__main__":
    try:
        test_synthetic()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        check("collaudo interrotto", False, e)
    if len(sys.argv) > 1:
        test_real(sys.argv[1])
    print(f"\n{len(OK)} riuscite, {len(KO)} non riuscite" + (": " + ", ".join(KO) if KO else ""))
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(1 if KO else 0)
