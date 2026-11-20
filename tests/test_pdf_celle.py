"""Editor PDF: il testo nelle celle di una tabella resta un blocco per cella (MuPDF le univa in un blocco solo e la
modifica di una cella riscriveva tutte le celle attaccate), e il testo riscritto resta sulla stessa linea di base.
    python tests/test_pdf_celle.py"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pymupdf  # noqa: E402

from mbvisual import pdfobjects as P  # noqa: E402

ok = ko = 0


def check(name, cond, extra=""):
    global ok, ko
    ok, ko = (ok + 1, ko) if cond else (ok, ko + 1)
    print(("  OK  " if cond else "  NO  ") + name + ("" if cond else f"  [{extra}]"))


tmp = tempfile.mkdtemp()
src = os.path.join(tmp, "tabella.pdf")
doc = pymupdf.open()
pg = doc.new_page(width=595, height=842)
xs = [40, 170, 300, 430, 520, 560]
for y in (100, 120, 160):
    pg.draw_line((40, y), (560, y), width=0.6)
for x in xs:
    pg.draw_line((x, 100), (x, 160), width=0.6)
vals = [["OF.RA"], ["GRUPPO C"], ["B-205"], ["/"], ["AFTER", "REPAIR"]]
tw = pymupdf.TextWriter(pg.rect)
f = pymupdf.Font("tiro")
for i, h in enumerate(["CLIENTE FINALE", "OGGETTO", "DISEGNO", "P.F.C.", "Fase"]):
    tw.append((xs[i] + 4, 114), h, font=f, fontsize=8)
for i, v in enumerate(vals):
    for k, t in enumerate(v):
        tw.append((xs[i] + 30 if i < 4 else xs[i] + 3, 136 + k * 10), t, font=f, fontsize=9)
tw.write_text(pg)
doc.save(src)

txt = {o["text"]: o for o in P.page_objects(src, 0)["oggetti"] if o["kind"] == "text"}
for t in ("OF.RA", "GRUPPO C", "B-205", "/", "OGGETTO", "DISEGNO"):
    check(f"cella '{t}' = blocco a se'", t in txt, list(txt))
check("AFTER e REPAIR nella stessa cella", any("AFTER" in t and "REPAIR" in t for t in txt), list(txt))
b = txt.get("B-205")
if b:
    w = os.path.join(tmp, "mod.pdf")
    shutil.copy(src, w)
    P.apply_ops(w, [{"kind": "text_block", "page": 0, "box": b["box"], "text": "A-205", "font": b["font"], "size": b["size"]}])
    after = {o["text"]: o["box"] for o in P.page_objects(w, 0)["oggetti"] if o["kind"] == "text"}
    for t in ("OF.RA", "GRUPPO C", "/"):
        check(f"'{t}' non si sposta", t in after and after[t] == txt[t]["box"], after.get(t))
    check("modificato in A-205", "A-205" in after and "B-205" not in after, list(after))
    base = [round(s["origin"][1], 2) for bl in pymupdf.open(w)[0].get_text("dict")["blocks"] for ln in bl.get("lines", [])
            for s in ln["spans"] if "205" in s["text"]]
    check("stessa linea di base", base == [136.0], base)
print(f"\n{ok} riuscite, {ko} non riuscite")
sys.exit(1 if ko else 0)
