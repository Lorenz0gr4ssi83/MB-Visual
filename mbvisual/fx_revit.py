"""Autodesk Revit (.rvt progetti, .rfa famiglie, .rte/.rft modelli) senza Revit.

Il file e' un contenitore OLE (Compound File): si leggono solo i flussi descrittivi, che Revit scrive in chiaro:
- BasicFileInfo: versione e build di Revit, condivisione (workset), file centrale, percorso di salvataggio, GUID
- RevitPreview4.0: anteprima PNG incorporata
- PartAtom (famiglie): XML Atom con categoria, versione, parametri e tipi
- TransmissionData: XML con i riferimenti esterni (collegamenti Revit/CAD, nuvole di punti, decalcomanie...)
La geometria resta nel formato proprietario e non viene letta. Libreria: olefile (BSD-2).

Perche' niente geometria (indagine del 28/10/2026 su famiglie Revit 2016 di DynamoRevit): i flussi Global/* e Partitions/*
sono segmenti gzip senza la coda CRC/ISIZE (deflate grezzo dopo i 10 byte d'intestazione); Formats/Latest e' lo schema delle
classi (nome, etichetta a 16 bit, campi con codice di tipo: 0x07 double, 0x04 intero, 0x0e riferimento...) e le partizioni
sono oggetti serializzati secondo quello schema. La geometria di una famiglia sta in elementi parametrici (ExtrusionElem,
BlendElem, schizzi di CurveElem) che rimandano a nodi GNode (FSRModelGNodeData) con le facce calcolate (GFace/GEdge): per
leggerla servirebbe decifrare l'intera serializzazione degli oggetti, che cambia a ogni versione di Revit. Nessun lettore
libero lo fa (rvt-rs, Apache-2.0, dichiara "no family geometry"); le alternative sono Revit stesso (Esporta IFC), il servizio
a pagamento Autodesk APS o la libreria commerciale ODA BimRv. Per questo l'IFC esportato da qui contiene i SOLI DATI della
famiglia (tipi, parametri, categoria -> classe IFC, OmniClass), senza geometria.
"""
from __future__ import annotations

import json
import re
from xml.etree import ElementTree as ET
from .i18n import t as tr

def _labels():  # testi nella lingua attiva al momento della richiesta
    return {
    "Worksharing": tr("srv_fx_revit.condivisione_lavoro"), "Username": tr("srv_fx_revit.utente"), "Central Model Path": tr("srv_fx_revit.percorso_modello_centrale"),
    "Revit Build": tr("srv_fx_revit.build_revit"), "Format": tr("srv_fx_revit.formato_versione"), "Build": "Build", "Last Save Path": tr("srv_fx_revit.ultimo_percorso_salvataggio"),
    "Open Workset Default": tr("srv_fx_revit.workset_aperti_impostazione"), "Project Spark File": tr("srv_fx_revit.file_spark"), "Central Model Identity": tr("srv_fx_revit.identita_modello_centrale"),
    "Locale when saved": tr("srv_fx_revit.lingua_salvataggio"), "All Local Changes Saved To Central": tr("srv_fx_revit.modifiche_locali_salvate_centrale"),
    "Central model's version number corresponding to the last reload latest": tr("srv_fx_revit.versione_centrale_all_ultimo_aggiornamento"),
    "Central model's episode GUID corresponding to the last reload latest": tr("srv_fx_revit.guid_dell_episodio_centrale"),
    "Unique Document GUID": tr("srv_fx_revit.guid_documento"), "Unique Document Increments": tr("srv_fx_revit.incrementi_documento"), "Model Identity": tr("srv_fx_revit.identita_modello"),
    "IsSingleUserCloudModel": tr("srv_fx_revit.modello_cloud_utente"), "Author": tr("srv_fx_revit.autore"),
}
def _worksharing():  # testi nella lingua attiva al momento della richiesta
    return {"Not enabled": tr("srv_fx_revit.non_attiva"), "Local": tr("srv_fx_revit.file_locale_copia_centrale"), "Central": tr("srv_fx_revit.file_centrale")}


def _ole(path):
    import olefile
    if not olefile.isOleFile(path):
        raise ValueError(tr("srv_fx_revit.non_file_revit_valido_contenitore"))
    return olefile.OleFileIO(path)


def _stream(o, name) -> bytes | None:
    try:
        return o.openstream(name).read() if o.exists(name) else None
    except Exception:
        return None


def _basic_info(b: bytes) -> list:
    """Le voci "Chiave: valore" del flusso BasicFileInfo (testo UTF-16 in mezzo a campi binari, a volte disallineato)."""
    rows = []
    texts = [b.decode("utf-16-le", "replace"), b[1:].decode("utf-16-le", "replace")]
    for k, label in _labels().items():
        for txt in texts:
            m = re.search(r"(?<![A-Za-z' (])" + re.escape(k) + r": ?([^\r\n\x00\u0a0d\ufffd]*)", txt)
            if m:
                v = m.group(1).strip()
                rows.append({"k": k, "campo": label, "valore": _worksharing().get(v, v) if k == "Worksharing" else v})
                break
    return rows


def _version(rows: list, raw: bytes) -> str:
    d = {r["k"]: r["valore"] for r in rows}
    if d.get("Format"):
        return d["Format"]
    m = re.search(r"Autodesk Revit(?: Architecture| Structure| MEP| LT)? (\d{4})", d.get("Revit Build", "") or raw.decode("utf-16-le", "replace"))
    return m.group(1) if m else ""


def _png(b: bytes | None) -> bytes | None:
    if not b:
        return None
    i = b.find(b"\x89PNG\r\n\x1a\n")
    if i < 0:
        return None
    j = b.find(b"IEND", i)
    return b[i:j + 8] if j > 0 else b[i:]


def _xml_utf16(b: bytes | None):
    if not b:
        return None
    for start in (4, 0, 2):
        try:
            txt = b[start:].decode("utf-16-le")
            k = txt.find("<")
            return ET.fromstring(txt[k:].strip("\x00").encode("utf-8").replace(b'encoding="utf-16"', b"")) if k >= 0 else None
        except Exception:
            continue
    return None


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _child(e, name):
    return next((c for c in e if _local(c.tag) == name), None) if e is not None else None


def _text(e, name, default=""):
    c = _child(e, name)
    return (c.text or "").strip() if c is not None and c.text else default


def _references(o) -> list:
    root = _xml_utf16(_stream(o, "TransmissionData"))
    out = []
    if root is None:
        return out
    for ref in (e for e in root.iter() if _local(e.tag) == "ExternalFileReference"):
        tipo = _text(ref, "ExternalFileReferenceType")
        path = _text(ref, "Path")
        if not path:
            continue  # tabelle interne (note chiave, codici di assieme) senza file collegato
        out.append({"tipo": tipo, "percorso": path, "tipo_percorso": _text(ref, "PathType"), "stato": _text(ref, "LinkedFileStatus"),
                    "id": _text(ref, "ElementId")})
    return out


def _part_atom(b: bytes | None) -> dict | None:
    if not b:
        return None
    try:
        root = ET.fromstring(b)
    except Exception:
        return None
    info = {"titolo": _text(root, "title"), "aggiornato": _text(root, "updated"), "categorie": [], "parametri": [], "tipi": [], "ospite": ""}
    for c in root:
        if _local(c.tag) == "category":
            term = _text(c, "term")
            if term and _text(c, "scheme").startswith("std:oc"):  # OmniClass (std:oc1 = tabella 23, prodotti)
                info.setdefault("omniclass", []).append(term)
            elif term:
                info["categorie"].append(term)
        if _local(c.tag) == "link":
            df = _child(c, "design-file")
            if df is not None:
                info["prodotto"] = _text(df, "product")
                info["versione_prodotto"] = _text(df, "product-version")
    feats = _child(root, "features")
    for feat in (feats if feats is not None else []):
        for grp in (g for g in feat if _local(g.tag) == "group"):
            gname = _text(grp, "title")
            for p in grp:
                if _local(p.tag) == "title":
                    continue
                info["parametri"].append({"gruppo": gname, "nome": p.get("displayName") or _local(p.tag).replace("_", " "),
                                          "valore": (p.text or "").strip(), "tipo": p.get("typeOfParameter") or "", "origine": p.get("type") or ""})
    fam = _child(root, "family")
    if fam is not None:
        info["ospite"] = _text(fam, "Host")
        info["numero_tipi"] = _text(fam, "variationCount")
        for part in (p for p in fam if _local(p.tag) == "part"):
            params = [{"nome": _local(x.tag).replace("_", " "), "valore": (x.text or "").strip(), "unita": x.get("units") or ""} for x in part if _local(x.tag) != "title"]
            info["tipi"].append({"nome": _text(part, "title"), "parametri": params})
    return info


def read(path: str) -> dict:
    o = _ole(path)
    try:
        bfi = _stream(o, "BasicFileInfo") or b""
        rows = _basic_info(bfi)
        streams = ["/".join(e) for e in o.listdir()]
        preview = _png(_stream(o, "RevitPreview4.0"))
        res = {"ok": True, "versione": _version(rows, bfi), "info": [{"campo": r["campo"], "valore": r["valore"]} for r in rows],
               "anteprima": bool(preview), "riferimenti": _references(o), "famiglia": _part_atom(_stream(o, "PartAtom")),
               "flussi": len(streams), "partizioni": len([s for s in streams if s.startswith("Partitions/")])}
        meta = {}
        try:
            m = o.get_metadata()
            for k in ("author", "last_saved_by", "create_time", "last_saved_time", "title", "subject"):
                v = getattr(m, k, None)
                if v:
                    meta[k] = v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)
        except Exception:
            pass
        res["metadati"] = meta
        ext = path.rsplit(".", 1)[-1].lower()
        res["tipo"] = {"rvt": tr("srv_fx_revit.progetto"), "rfa": tr("srv_fx_revit.famiglia"), "rte": tr("srv_fx_revit.modello_progetto"), "rft": tr("srv_fx_revit.modello_famiglia")}.get(ext, tr("srv_fx_revit.file_revit"))
        return res
    finally:
        o.close()


def preview(path: str):
    o = _ole(path)
    try:
        png = _png(_stream(o, "RevitPreview4.0"))
    finally:
        o.close()
    if not png:
        raise ValueError(tr("srv_fx_revit.file_non_contiene_anteprima"))
    return png, {"Content-Type": "image/png"}


def export(path: str, out: str) -> dict:
    ext = out.rsplit(".", 1)[-1].lower()
    if ext == "png":
        data, _ = preview(path)
        with open(out, "wb") as f:
            f.write(data)
    elif ext == "json":
        with open(out, "w", encoding="utf-8") as f:
            json.dump(read(path), f, ensure_ascii=False, indent=2)
    elif ext == "ifc":
        r = read(path)
        if not r.get("famiglia"):
            raise ValueError(tr("srv_fx_revit.ifc_solo_famiglie"))
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            f.write(family_ifc(r, path))
    elif ext == "txt":
        r = read(path)
        lines = [tr("srv_fx_revit.0_revit_1", r['tipo'], r['versione']).strip(), ""]
        lines += [f"{x['campo']}: {x['valore']}" for x in r["info"]]
        fam = r.get("famiglia")
        if fam:
            lines += ["", tr("srv_fx_revit.famiglia_0", fam['titolo']), tr("srv_fx_revit.categoria_0", ', '.join(fam['categorie'])), tr("srv_fx_revit.ospite_0", fam['ospite']), tr("srv_fx_revit.tipi_0", fam.get('numero_tipi', ''))]
            lines += [f"  [{p['gruppo']}] {p['nome']} = {p['valore']}" for p in fam["parametri"]]
            for t in fam["tipi"]:
                lines += [tr("srv_fx_revit.tipo_0", t['nome'])] + [f"  {p['nome']} = {p['valore']} {p['unita']}".rstrip() for p in t["parametri"]]
        if r["riferimenti"]:
            lines += ["", tr("srv_fx_revit.riferimenti_esterni")] + [f"  {x['tipo']}: {x['percorso']} ({x['stato']})" for x in r["riferimenti"]]
        with open(out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    else:
        raise ValueError(tr("srv_fx_revit.formato_non_previsto_0", ext))
    return {"ok": True, "path": out}

# ------------------------------------------------------------------ IFC 4 con i soli dati della famiglia
# Categoria Revit (inglese come in PartAtom, o italiano) -> (tipo IFC, attributi dopo ElementType, occorrenza, attributi dopo Tag)
_IFC_MAP = [
    (("doors", "porte"), "IFCDOORTYPE", ".DOOR.,.NOTDEFINED.,$,$", "IFCDOOR", "$,$,.DOOR.,.NOTDEFINED.,$"),
    (("windows", "finestre"), "IFCWINDOWTYPE", ".WINDOW.,.NOTDEFINED.,$,$", "IFCWINDOW", "$,$,.WINDOW.,.NOTDEFINED.,$"),
    (("furniture", "furniture systems", "casework", "arredi", "sistemi di arredo", "arredi fissi"), "IFCFURNITURETYPE",
     ".NOTDEFINED.,.NOTDEFINED.", "IFCFURNITURE", ".NOTDEFINED."),
    (("structural columns", "columns", "pilastri strutturali", "pilastri"), "IFCCOLUMNTYPE", ".COLUMN.", "IFCCOLUMN", ".COLUMN."),
    (("structural framing", "telaio strutturale"), "IFCBEAMTYPE", ".BEAM.", "IFCBEAM", ".BEAM."),
    (("structural foundations", "fondazioni strutturali"), "IFCFOOTINGTYPE", ".NOTDEFINED.", "IFCFOOTING", ".NOTDEFINED."),
    (("railings", "ringhiere"), "IFCRAILINGTYPE", ".NOTDEFINED.", "IFCRAILING", ".NOTDEFINED."),
    (("plumbing fixtures", "apparecchi idraulici", "impianti idraulici"), "IFCSANITARYTERMINALTYPE", ".NOTDEFINED.", "IFCSANITARYTERMINAL", ".NOTDEFINED."),
    (("lighting fixtures", "apparecchi di illuminazione", "lighting devices", "dispositivi di illuminazione"), "IFCLIGHTFIXTURETYPE", ".NOTDEFINED.", "IFCLIGHTFIXTURE", ".NOTDEFINED."),
    (("electrical fixtures", "apparecchi elettrici"), "IFCOUTLETTYPE", ".NOTDEFINED.", "IFCOUTLET", ".NOTDEFINED."),
    (("electrical equipment", "attrezzatura elettrica"), "IFCELECTRICDISTRIBUTIONBOARDTYPE", ".NOTDEFINED.", "IFCELECTRICDISTRIBUTIONBOARD", ".NOTDEFINED."),
    (("mechanical equipment", "attrezzature meccaniche", "apparecchiature meccaniche"), "IFCUNITARYEQUIPMENTTYPE", ".NOTDEFINED.", "IFCUNITARYEQUIPMENT", ".NOTDEFINED."),
    (("air terminals", "terminali d'aria", "bocchette"), "IFCAIRTERMINALTYPE", ".NOTDEFINED.", "IFCAIRTERMINAL", ".NOTDEFINED."),
    (("duct fittings", "raccordi condotto"), "IFCDUCTFITTINGTYPE", ".NOTDEFINED.", "IFCDUCTFITTING", ".NOTDEFINED."),
    (("duct accessories", "accessori condotto"), "IFCDAMPERTYPE", ".NOTDEFINED.", "IFCDAMPER", ".NOTDEFINED."),
    (("pipe fittings", "raccordi tubazione"), "IFCPIPEFITTINGTYPE", ".NOTDEFINED.", "IFCPIPEFITTING", ".NOTDEFINED."),
    (("pipe accessories", "accessori tubazione"), "IFCVALVETYPE", ".NOTDEFINED.", "IFCVALVE", ".NOTDEFINED."),
    (("sprinklers", "sprinkler"), "IFCFIRESUPPRESSIONTERMINALTYPE", ".SPRINKLER.", "IFCFIRESUPPRESSIONTERMINAL", ".SPRINKLER."),
    (("planting", "piantumazione", "vegetazione"), "IFCGEOGRAPHICELEMENTTYPE", ".NOTDEFINED.", "IFCGEOGRAPHICELEMENT", ".NOTDEFINED."),
]
_IFC_PROXY = ("IFCBUILDINGELEMENTPROXYTYPE", ".NOTDEFINED.", "IFCBUILDINGELEMENTPROXY", ".NOTDEFINED.")
_LEN_UNITS = {"mm": 0.001, "millimeters": 0.001, "millimetri": 0.001, "cm": 0.01, "centimeters": 0.01, "m": 1.0, "meters": 1.0,
              "metri": 1.0, "ft": 0.3048, "feet": 0.3048, "in": 0.0254, "inches": 0.0254}
_YES = ("Yes", "Si", "Sì", "1")
_NO = ("No", "0")


def ifc_class(categories: list) -> tuple:
    """Classi IFC (tipo, attributi del tipo, occorrenza, attributi dell'occorrenza) dalla categoria della famiglia."""
    for c in (x.strip().lower() for x in categories or []):
        for names, ty, ty_attrs, occ, occ_attrs in _IFC_MAP:
            if c in names:
                return ty, ty_attrs, occ, occ_attrs
    return _IFC_PROXY


def _ifc_str(s) -> str:
    """Stringa STEP: apostrofi e barre raddoppiati, caratteri non ASCII in \\X2\\....\\X0\\."""
    out = []
    for ch in str(s):
        code = ord(ch)
        if ch == "'":
            out.append("''")
        elif ch == "\\":
            out.append("\\\\")
        elif 32 <= code < 127:
            out.append(ch)
        elif code < 32:
            out.append(" ")
        elif code > 0xFFFF:  # coppia surrogata in UTF-16
            code -= 0x10000
            out.append("\\X2\\%04X%04X\\X0\\" % (0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF)))
        else:
            out.append("\\X2\\%04X\\X0\\" % code)
    return "'" + "".join(out) + "'"


def _ifc_guid() -> str:
    """GlobalId IFC: 128 bit in 22 caratteri (il primo porta solo 2 bit)."""
    import uuid
    chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"
    n = uuid.uuid4().int
    return chars[(n >> 126) & 3] + "".join(chars[(n >> (6 * i)) & 63] for i in range(20, -1, -1))


def _ifc_value(value: str, kind: str = "", unit: str = "") -> str:
    v = (value or "").strip()
    if (kind == "Yes/No" or not unit) and v in _YES + _NO and (kind == "Yes/No" or v in ("Yes", "No")):
        return "IFCBOOLEAN(%s)" % (".T." if v in _YES else ".F.")
    f = _LEN_UNITS.get(unit.strip().lower())
    if f is not None:
        try:
            return "IFCLENGTHMEASURE(%s)" % repr(float(v.replace(",", ".")) * f)
        except ValueError:
            pass
    return "IFCLABEL(%s)" % _ifc_str(v + (" " + unit if unit else ""))


def family_ifc(r: dict, path: str) -> str:
    """IFC 4 senza geometria: progetto, un tipo IFC e un'occorrenza (senza rappresentazione) per ogni tipo della famiglia,
    proprieta' dai gruppi di parametri di PartAtom, classificazione OmniClass se presente."""
    import os
    import time
    fam = r["famiglia"]
    lines: list[str] = []

    def A(txt: str) -> int:
        lines.append(txt)
        return len(lines)

    def G() -> str:
        return _ifc_str(_ifc_guid())

    name = fam.get("titolo") or os.path.splitext(os.path.basename(path))[0]
    org = A("IFCORGANIZATION($,'MB Group',$,$,$)")
    app = A(f"IFCAPPLICATION(#{org},'1','MB Desk','MBVisual')")
    per = A("IFCPERSON($,$,'MB Desk',$,$,$,$,$)")
    pao = A(f"IFCPERSONANDORGANIZATION(#{per},#{org},$)")
    own = A(f"IFCOWNERHISTORY(#{pao},#{app},$,.ADDED.,$,$,$,{int(time.time())})")
    o = A("IFCCARTESIANPOINT((0.,0.,0.))")
    z = A("IFCDIRECTION((0.,0.,1.))")
    x = A("IFCDIRECTION((1.,0.,0.))")
    wcs = A(f"IFCAXIS2PLACEMENT3D(#{o},#{z},#{x})")
    ctx = A(f"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#{wcs},$)")
    uL = A("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)")
    uA = A("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)")
    uV = A("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)")
    units = A(f"IFCUNITASSIGNMENT((#{uL},#{uA},#{uV}))")
    proj = A(f"IFCPROJECT({G()},#{own},{_ifc_str(name)},{_ifc_str(tr('srv_fx_revit.ifc_descrizione'))},$,$,$,(#{ctx}),#{units})")
    sp = A(f"IFCLOCALPLACEMENT($,#{wcs})")
    site = A(f"IFCSITE({G()},#{own},'Site',$,$,#{sp},$,$,.ELEMENT.,$,$,$,$,$)")
    bp = A(f"IFCLOCALPLACEMENT(#{sp},#{wcs})")
    bld = A(f"IFCBUILDING({G()},#{own},'Building',$,$,#{bp},$,$,.ELEMENT.,$,$,$)")
    stp = A(f"IFCLOCALPLACEMENT(#{bp},#{wcs})")
    sto = A(f"IFCBUILDINGSTOREY({G()},#{own},'Level 0',$,$,#{stp},$,$,.ELEMENT.,0.)")
    A(f"IFCRELAGGREGATES({G()},#{own},$,$,#{proj},(#{site}))")
    A(f"IFCRELAGGREGATES({G()},#{own},$,$,#{site},(#{bld}))")
    A(f"IFCRELAGGREGATES({G()},#{own},$,$,#{bld},(#{sto}))")

    def pset(pname: str, props: list) -> int | None:
        ids = [A(f"IFCPROPERTYSINGLEVALUE({_ifc_str(n)},$,{v},$)") for n, v in props if n]
        if not ids:
            return None
        return A(f"IFCPROPERTYSET({G()},#{own},{_ifc_str(pname)},$,({','.join('#%d' % i for i in ids)}))")

    cats = fam.get("categorie") or []
    ty_cls, ty_attrs, occ_cls, occ_attrs = ifc_class(cats)
    base = [(tr("srv_fx_revit.ifc_famiglia"), _ifc_value(name)), (tr("srv_fx_revit.ifc_categoria"), _ifc_value(", ".join(cats))),
            (tr("srv_fx_revit.ifc_file"), _ifc_value(os.path.basename(path)))]
    if fam.get("ospite"):
        base.append((tr("srv_fx_revit.ifc_ospite"), _ifc_value(fam["ospite"])))
    if r.get("versione"):
        base.append((tr("srv_fx_revit.ifc_versione_revit"), _ifc_value(r["versione"])))
    groups: dict[str, list] = {}
    for p in fam.get("parametri", []):
        groups.setdefault(p["gruppo"] or "Revit", []).append((p["nome"], _ifc_value(p["valore"], p.get("tipo", ""))))

    occs = []
    for ty in fam.get("tipi") or [{"nome": name, "parametri": []}]:
        tname = ty.get("nome") or name
        own_ps = pset(tr("srv_fx_revit.ifc_parametri_tipo"),
                      [(p["nome"], _ifc_value(p["valore"], "", p.get("unita", ""))) for p in ty.get("parametri", [])])
        # un property set definisce al massimo un tipo (IFC4 DefinesType [0:1]): si ripetono per ogni tipo
        ps = [c for c in [pset("Revit", base)] + [pset(g, props) for g, props in groups.items()] + [own_ps] if c]
        has = "(" + ",".join("#%d" % i for i in ps) + ")" if ps else "$"
        full = _ifc_str(name + ":" + tname)
        tid = A(f"{ty_cls}({G()},#{own},{full},$,$,{has},$,$,{_ifc_str(tname)},{ty_attrs})")
        op = A(f"IFCLOCALPLACEMENT(#{stp},#{wcs})")
        oid = A(f"{occ_cls}({G()},#{own},{full},$,{_ifc_str(tname)},#{op},$,$,{occ_attrs})")
        A(f"IFCRELDEFINESBYTYPE({G()},#{own},$,$,(#{oid}),#{tid})")
        occs.append(oid)
    A(f"IFCRELCONTAINEDINSPATIALSTRUCTURE({G()},#{own},$,$,({','.join('#%d' % i for i in occs)}),#{sto})")
    oc = fam.get("omniclass") or []
    if oc:
        cl = A("IFCCLASSIFICATION('OCCS','2006',$,'OmniClass',$,$,$)")
        for code in oc:
            ref = A(f"IFCCLASSIFICATIONREFERENCE($,{_ifc_str(code)},$,#{cl},$,$)")
            A(f"IFCRELASSOCIATESCLASSIFICATION({G()},#{own},$,$,({','.join('#%d' % i for i in occs)}),#{ref})")

    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    head = ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
            f"FILE_NAME({_ifc_str(name + '.ifc')},'{stamp}',(''),(''),'MB Desk','MB Desk','');", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;"]
    body = [f"#{i + 1}={ln};" for i, ln in enumerate(lines)]
    return "\n".join(head + body + ["ENDSEC;", "END-ISO-10303-21;", ""])
