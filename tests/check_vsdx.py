"""Controllo strutturale di un .vsdx scritto da MB Visual (senza Visio): XML ben formato, tipi di contenuto e
relazioni per ogni parte, ordine degli elementi nelle forme come nello schema [MS-VSDX] (Cell, Trigger, Section,
Text, Data1-3, ForeignData, Shapes), ID unici per pagina, Connect con forme esistenti, righe con T o IX/N.

    python tests/check_vsdx.py file.vsdx [altri.vsdx]
"""
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET

V = "{http://schemas.microsoft.com/office/visio/2012/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"
CT = "{http://schemas.openxmlformats.org/package/2006/content-types}"
ORDER = {"Cell": 0, "Trigger": 1, "Section": 2, "Text": 3, "Data1": 4, "Data2": 5, "Data3": 6, "ForeignData": 7, "Shapes": 8}


def check(path: str) -> list[str]:
    err = []
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    xml = {}
    for n in names:
        if n.endswith(".xml") or n.endswith(".rels"):
            try:
                xml[n] = ET.fromstring(z.read(n))
            except ET.ParseError as e:
                err.append(f"{n}: XML non valido ({e})")
    ct = xml.get("[Content_Types].xml")
    if ct is None:
        return err + ["manca [Content_Types].xml"]
    defaults = {e.get("Extension").lower() for e in ct.findall(CT + "Default")}
    overrides = {e.get("PartName").lstrip("/") for e in ct.findall(CT + "Override")}
    for n in names:
        if n.endswith("/"):
            continue
        ext = n.rsplit(".", 1)[-1].lower()
        if n not in overrides and ext not in defaults:
            err.append(f"{n}: nessun tipo di contenuto")
    for o in overrides:
        if o not in names:
            err.append(f"Override per una parte che non esiste: {o}")
    # relazioni
    for n, root in xml.items():
        if not n.endswith(".rels"):
            continue
        base = posixpath.dirname(posixpath.dirname(n))
        for r in root.findall(PR + "Relationship"):
            if r.get("TargetMode") == "External":
                continue
            t = posixpath.normpath(posixpath.join(base, r.get("Target"))) if not r.get("Target").startswith("/") else r.get("Target")[1:]
            if t not in names:
                err.append(f"{n}: {r.get('Id')} punta a {t}, che non esiste")
    # pagine e master
    for n, root in xml.items():
        if not (n.startswith("visio/pages/page") or n.startswith("visio/masters/master")) or not n.endswith(".xml"):
            continue
        ids = set()
        for sh in root.iter(V + "Shape"):
            i = sh.get("ID")
            if sh.get("Del") == "1":
                continue
            if i in ids:
                err.append(f"{n}: ID ripetuto {i}")
            ids.add(i)
            last = -1
            for c in sh:
                tag = c.tag.replace(V, "")
                o = ORDER.get(tag)
                if o is None:
                    err.append(f"{n}: forma {i}: elemento inatteso {tag}")
                    continue
                if o < last:
                    err.append(f"{n}: forma {i}: {tag} fuori ordine")
                last = o
            for sec in sh.findall(V + "Section"):
                for row in sec.findall(V + "Row"):
                    if row.get("IX") is None and row.get("N") is None:
                        err.append(f"{n}: forma {i}: riga senza IX/N in {sec.get('N')}")
                    for c in row.findall(V + "Cell"):
                        if c.get("N") is None or c.get("V") is None and c.get("F") is None:
                            err.append(f"{n}: forma {i}: cella senza N/V in {sec.get('N')}")
            for c in sh.findall(V + "Cell"):
                if c.get("N") is None:
                    err.append(f"{n}: forma {i}: cella senza nome")
        cons = root.find(V + "Connects")
        if cons is not None:
            for c in cons.findall(V + "Connect"):
                for a in ("FromSheet", "ToSheet"):
                    if c.get(a) not in ids:
                        err.append(f"{n}: Connect {a}={c.get(a)} non esiste")
        kids = [c.tag.replace(V, "") for c in root]
        if kids and n.startswith("visio/pages/") and kids != sorted(kids, key=lambda k: ["Shapes", "Connects"].index(k) if k in ("Shapes", "Connects") else 9):
            err.append(f"{n}: ordine Shapes/Connects errato {kids}")
    return err


if __name__ == "__main__":
    bad = 0
    for f in sys.argv[1:]:
        e = check(f)
        print(("OK  " if not e else "ERR ") + f)
        for x in e[:40]:
            print("    " + x)
        bad += bool(e)
    sys.exit(1 if bad else 0)
