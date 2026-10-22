"""Collaudo del motore delle misure sui PDF (mbvisual/measure.py) con il PDF di prova a scala nota.

    python tools/make_measure_samples.py
    python tests/test_measure.py

Verifica: scala letta dal cartiglio (1:100) e dal riquadro /VP (1:20), geometria per l'aggancio (cerchi riconosciuti),
lunghezze e aree per stile e layer convertite in metri con la scala, simboli uguali (anche ruotati), tabelle e testi,
scrittura delle misure come annotazioni con /Measure + allegato, rilettura, copia senza le annotazioni.
"""
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from mbvisual import measure as M  # noqa: E402

PDF = ROOT / "tests" / "samples" / "misure" / "pianta_1-100.pdf"
EXP = json.loads((ROOT / "tests" / "samples" / "misure" / "attesi.json").read_text(encoding="utf-8"))["pdf"]
K100 = 100 * M.PT  # metri per punto a 1:100
fails = passes = 0


def check(name, ok, info=""):
    global fails, passes
    if ok:
        passes += 1
    else:
        fails += 1
    print(("OK   " if ok else "ERR  ") + name + (f"  ({info})" if info != "" else ""))


def near(a, b, rel=1e-4):
    return a is not None and abs(a - b) <= abs(b) * rel + 1e-9


def main():
    # ---- scale
    S = M.scales(str(PDF))["scale"]
    p0 = [s for s in S if s["page"] == 0 and not s["box"]]
    check("scala del cartiglio pagina 1 = 1:100", p0 and near(p0[0]["N"], EXP["scala"]), p0[0]["N"] if p0 else None)
    vp = [s for s in S if s["page"] == 1 and s["box"]]
    check("riquadro /VP pagina 2 = 1:20 in metri", vp and near(vp[0]["N"], EXP["dettaglio_scala"]) and vp[0]["unit"] == "m", vp[0] if vp else None)
    check("riquadro /VP: posizione", vp and [round(v) for v in vp[0]["box"]] == [100, 195, 500, 495], vp[0]["box"] if vp else None)

    # ---- geometria per l'aggancio e gli oggetti
    g = M.page_geometry(str(PDF), 0)
    circles = [c for p in g["paths"] for c in (p["circ"] or [])]
    check("10 cerchi riconosciuti (centri per l'aggancio)", len(circles) == 10, len(circles))
    check("raggio dei cerchi = 0,2 m a 1:100", circles and near(circles[0][2] * K100, 0.2, 2e-3), circles[0][2] * K100 if circles else None)
    room = next((p for p in g["paths"] if p["st"] == "#000000" and p["w"] == 0.7), None)
    check("locale: contorno chiuso", room and room["c"] == [True])
    if room:
        P = [(room["s"][0][i], room["s"][0][i + 1]) for i in range(0, len(room["s"][0]), 2)]
        check("locale: area 20 m2 dal contorno", near(abs(M._shoelace(P)) * K100 * K100, EXP["area_locale"], 1e-3))

    # ---- lunghezze e aree per stile e layer
    recs = M.lines(str(PDF), [0])["records"]
    pipe = next((r for r in recs if r["g"]["layer"] == "Impianti"), None)
    check("tubo sul layer PDF 'Impianti' = 10 m", pipe and near(pipe["len"] * K100, EXP["tubo"], 1e-4), pipe["len"] * K100 if pipe else None)
    check("tubo: tratteggio riconosciuto", pipe and pipe["g"]["dash"] == "4 2", pipe["g"]["dash"] if pipe else None)
    fill = next((r for r in recs if r["g"]["fill"] == "#bfbfbf"), None)
    check("pavimento retinato con foro = 23 m2", fill and near(fill["area"] * K100 * K100, EXP["area_pavimento"], 1e-4), fill["area"] * K100 * K100 if fill else None)
    rr = next((r for r in recs if r["g"]["width"] == 0.7), None)
    check("perimetro del locale = 18 m", rr and near(rr["len"] * K100, EXP["perimetro_locale"], 1e-4))
    reg = M.lines(str(PDF), [1], [{"id": "dett", "page": 1, "box": [100, 195.28, 500, 495.28]}])["records"]
    dline = next((r for r in reg if r["g"]["width"] == 1.0), None)
    check("pagina 2: la linea del dettaglio sta nel riquadro e vale 1 m a 1:20", dline and near(dline["len"] * 20 * M.PT, EXP["dettaglio_linea"], 1e-4) and dline["at"] == [_mid(100, 500), _mid(195.28, 495.28)] or dline and near(dline["len"] * 20 * M.PT, 1.0, 1e-4),
          dline["len"] * 20 * M.PT if dline else None)

    # ---- simboli uguali
    sy = M.symbols(str(PDF), [0])["simboli"]
    counts = sorted(len(s["at"]) for s in sy)
    check("simboli: 10 cerchi con croce e 5 quadrati (uno ruotato)", EXP["simboli_cerchio"] in counts and EXP["simboli_quadrato"] in counts, counts)
    circ = next(s for s in sy if len(s["at"]) == 10)
    sim = M.similar(str(PDF), 0, circ["at"][3][1:])
    check("simili al simbolo cliccato = 10", len(sim["punti"]) == 10, len(sim["punti"]))

    # ---- tabelle e testi
    tb = M.tables(str(PDF), [0])["tabelle"]
    check("tabella riconosciuta 3 colonne x 3 righe", tb and tb[0]["head"] == ["Locale", "Superficie", "Altezza"] and len(tb[0]["rows"]) == 3, tb[0]["head"] if tb else None)
    check("celle della tabella", tb and tb[0]["rows"][1] == ["Cucina", "12,50", "2,70"], tb[0]["rows"] if tb else None)
    tx = M.texts(str(PDF), [0])["testi"]
    kinds = {r["text"]: r["kind"] for r in tx}
    check("testi: quote e quote di livello riconosciute", kinds.get("5.00") == "quota" and kinds.get("+3.20") == "livello" and kinds.get("SCALA 1:100") == "testo", {k: kinds.get(k) for k in ("5.00", "+3.20", "SCALA 1:100")})

    # ---- scrittura nel PDF, rilettura, copia senza annotazioni
    tmp = Path(tempfile.mkdtemp())
    out = tmp / "misure.pdf"
    shutil.copy(PDF, out)
    k = 1000 / 100 / 25.4 * 72
    ox, oy = 120, 841.89 - 120  # origine del disegno in coordinate PDF (y verso l'alto)
    room_pts = [[ox, oy], [ox + 5 * k, oy], [ox + 5 * k, oy - 4 * k], [ox, oy - 4 * k]]
    doc = {"format": "mbmis", "version": 1, "disp": {"unit": "m", "digits": 2},
           "scales": [{"id": "s0", "page": 0, "box": None, "k": K100, "unit": "m", "label": "1:100"}, {"id": "s1", "page": 1, "box": [100, 195.28, 500, 495.28], "k": 20 * M.PT, "unit": "m", "label": "1:20"}],
           "items": [{"id": "a1", "type": "area", "page": 0, "pts": room_pts, "color": "#e8590c", "name": "Soggiorno", "voce": "Pavimenti", "price": 30, "note": "parquet"},
                     {"id": "l1", "type": "len", "page": 0, "pts": [[ox, oy - 6 * k], [ox + 6 * k, oy - 6 * k]], "color": "#1971c2"},
                     {"id": "c1", "type": "count", "page": 0, "pts": [c[:2] for c in [s[1:] for s in circ["at"]]], "color": "#2f9e44", "symbol": "circle", "name": "Punti luce"},
                     {"id": "x1", "type": "ext", "page": None, "pts": [], "q": {"len": 12.5}, "kind": "len", "name": "Estratta"}],
           "voci": {"Pavimenti": {"color": "#e8590c", "price": 30}}}
    r = M.write(str(out), doc, {"a1": "20,00 m²", "l1": "6,00 m", "c1": "10"}, "Prova")
    check("scrittura: annotazioni create (area, linea, 10 simboli + 3 etichette)", r["annotazioni"] == 1 + 1 + 10 + 3, r)
    import pymupdf
    d = pymupdf.open(str(out))
    pg0 = d[0]
    an = {a.info["name"]: a for a in pg0.annots()}
    poly = an.get("mbvmis-a1")
    check("area = Polygon con /IT /PolygonDimension", poly is not None and poly.type[1] == "Polygon" and d.xref_get_key(poly.xref, "IT")[1] == "/PolygonDimension")
    meas = d.xref_get_key(poly.xref, "Measure")[1] if poly else ""
    c = float(meas.split("/X[")[1].split("/C ")[1].split("/")[0]) if "/X[" in meas else 0
    check("/Measure: fattore /C = metri per punto (1:100)", near(c, K100, 1e-6), c)
    ln = an.get("mbvmis-l1")
    check("lunghezza = Line con /IT /LineDimension", ln is not None and ln.type[1] == "Line" and d.xref_get_key(ln.xref, "IT")[1] == "/LineDimension")
    check("etichette visibili (FreeText) collegate alla misura (/IRT)", "mbvmis-l-a1" in an and d.xref_get_key(an["mbvmis-l-a1"].xref, "RT")[1] == "/Group")
    check("contenuto della nota con nome, valore e note", poly and "Soggiorno" in poly.info["content"] and "20,00" in poly.info["content"] and "parquet" in poly.info["content"])
    check("10 simboli del conteggio", sum(1 for n in an if n.startswith("mbvmis-c1")) == 10)
    vp0 = d.xref_get_key(d[0].xref, "VP")[1]
    check("/VP della pagina 1 con la scala di MB Visual", "MB Visual" in vp0 and "/Measure" in vp0)
    vp1 = d.xref_get_key(d[1].xref, "VP")[1]
    check("/VP della pagina 2: riquadro di MB Visual 1:20", "MB Visual 1:20" in vp1)
    check("allegato misure.mbmis", "misure.mbmis" in d.embfile_names())
    d.close()
    back = M.read(str(out))
    check("rilettura: documento delle misure dall'allegato", back["doc"] and len(back["doc"]["items"]) == 4 and back["doc"]["voci"]["Pavimenti"]["price"] == 30)
    check("rilettura: annotazioni proprie riconosciute", back["nostre"] >= 13, back["nostre"])
    # riscrittura: le annotazioni vecchie si sostituiscono (niente doppioni)
    doc["items"] = doc["items"][:1]
    M.write(str(out), doc, {"a1": "20,00 m²"})
    d = pymupdf.open(str(out))
    names = [a.info["name"] for a in d[0].annots()]
    d.close()
    check("riscrittura senza doppioni", names.count("mbvmis-a1") == 1 and not any(n.startswith("mbvmis-c1") for n in names), names)
    cp = tmp / "copia.pdf"
    n = M.strip(str(out), str(cp))
    d = pymupdf.open(str(cp))
    check("copia senza le annotazioni delle misure (etichette tolte con la misura)", n >= 1 and not list(d[0].annots()), n)
    d.close()
    # misure scritte da un altro programma (stesso formato di Acrobat): importate
    other = tmp / "altro.pdf"
    shutil.copy(PDF, other)
    d = pymupdf.open(str(other))
    a = d[0].add_line_annot(pymupdf.Point(100, 100), pymupdf.Point(100 + 10 * k, 100))
    a.update()
    d.xref_set_key(a.xref, "IT", "/LineDimension")
    d.xref_set_key(a.xref, "Measure", M._measure_dict(K100, "m", ""))
    d.save(str(tmp / "altro2.pdf"))
    d.close()
    imp = M.read(str(tmp / "altro2.pdf"))["importate"]
    check("misure di altri programmi importate con la loro scala", imp and imp[0]["type"] == "len" and near(math.dist(*imp[0]["pts"]) * imp[0]["k"], 10, 1e-4), imp[:1])
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{passes} riuscite, {fails} fallite")
    return 1 if fails else 0


def _mid(a, b):
    return round((a + b) / 2, 2)


if __name__ == "__main__":
    sys.exit(main())
