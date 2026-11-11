"""ifcXML (IFC4 / IFC4x3, ISO 10303-28) -> IFC in formato STEP, con IfcOpenShell (LGPL) che da' schema e scrittura.
IfcOpenShell 0.9 non legge l'ifcXML: qui si traduce l'albero XML in entita' seguendo lo schema (scritto qui, nessun codice altrui):
- un elemento il cui nome (o xsi:type) e' un'entita' dello schema = un'istanza; id="iN" la rende citabile, href="iN" la cita;
- attributi XML = attributi semplici dell'entita' (liste separate da spazi, enumerazioni in minuscolo, true/false/unknown);
- elementi figli col nome di un attributo DIRETTO = il suo valore (entita', lista, valore tipizzato come <IfcLabel>x</IfcLabel>);
- figli col nome di un attributo INVERSO (HasAssignments, Declares, IsDefinedBy...) = l'altra entita' punta a questa;
- un attributo semplice scritto come elemento (<Name>x</Name>) e' accettato.
Il file IFC risultante sta in cache (TEMP/ifcxml) e si apre col visualizzatore 3D come qualsiasi IFC. Oggetti e valori che lo schema
non accetta si saltano e si contano nel rapporto (`saltati`)."""
import hashlib
import os
import re
import xml.etree.ElementTree as ET

from .i18n import t as tr
from .paths import TEMP_DIR

CACHE = TEMP_DIR / "ifcxml"
VERSION = 1
XSI = "{http://www.w3.org/2001/XMLSchema-instance}"


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _schema_of(root, text_head):
    m = re.search(r'schema_name="(IFC\w+)"', text_head)
    if m and m.group(1).upper() in ("IFC2X3", "IFC4", "IFC4X3"):
        return m.group(1).upper()
    m = re.search(r"IFC4X3|IFC4x3", text_head)
    if m:
        return "IFC4X3"
    if re.search(r"IFC2X3|IFC2x3", text_head):
        return "IFC2X3"
    return "IFC4"


class Conv:
    def __init__(self, schema_name):
        import ifcopenshell
        import ifcopenshell.ifcopenshell_wrapper as W
        self.W = W
        self.schema = W.schema_by_name(schema_name)
        self.f = ifcopenshell.file(schema=schema_name)
        self.ids = {}
        self.pending = []  # (entita', nome attributo, elemento xml) da risolvere dopo
        self.inv = []  # (entita' figlia, nome attributo diretto, entita' madre, aggregato?)
        self.skipped = 0
        self._attrs = {}

    # ------------------------------------------------------------- schema
    def decl(self, name):
        try:
            return self.schema.declaration_by_name(name)
        except Exception:  # noqa: BLE001
            return None

    def is_entity(self, name):
        d = self.decl(name)
        return d is not None and d.as_entity() is not None

    def attrs(self, ent_name):
        if ent_name not in self._attrs:
            e = self.decl(ent_name).as_entity()
            direct = {a.name(): a for a in e.all_attributes()}
            inverse = {a.name(): a for a in e.all_inverse_attributes()}
            self._attrs[ent_name] = (direct, inverse)
        return self._attrs[ent_name]

    def _base(self, t):
        """tipo dello schema -> ('simple', nome) | ('enum', valori) | ('select', decl) | ('entity', nome) | ('agg', tipo interno)"""
        if t.as_aggregation_type():
            return ("agg", t.as_aggregation_type().type_of_element())
        if t.as_simple_type():
            return ("simple", t.as_simple_type().declared_type())
        nt = t.as_named_type()
        if nt:
            d = nt.declared_type()
            if d.as_enumeration_type():
                return ("enum", d)
            if d.as_select_type():
                return ("select", d)
            if d.as_entity():
                return ("entity", d.name())
            if d.as_type_declaration():
                return ("typedecl", d)
        return ("simple", "string")

    def _simple(self, text, kind):
        text = text.strip()
        if kind in ("integer",):
            return int(float(text))
        if kind in ("real", "number"):
            return float(text)
        if kind == "boolean":
            return text.lower() in ("true", "1", ".t.")
        if kind == "logical":
            return {"true": True, "false": False}.get(text.lower(), "UNKNOWN")
        return text

    def value(self, text, t):
        """testo di un attributo XML -> valore Python per l'attributo di tipo t"""
        k, x = self._base(t)
        if k == "agg":
            parts = text.split()
            kk, xx = self._base(x)
            if kk == "agg":  # liste di liste (rare negli attributi): righe separate da ";" non previste
                return [self.value(p, xx) for p in parts]
            return [self.value(p, x) for p in parts] if kk != "simple" or xx != "string" else ([text] if parts else [])
        if k == "simple":
            return self._simple(text, x)
        if k == "enum":
            return text.upper()
        if k == "typedecl":
            return self.value(text, x.declared_type())
        if k == "select":
            return text  # raro come attributo XML
        return None

    def typed(self, el):
        """<IfcLabel>x</IfcLabel> o <IfcLengthMeasure>0.3</IfcLengthMeasure> -> entita' del tipo definito"""
        name = _local(el.attrib.get(XSI + "type", el.tag)).replace("-wrapper", "")
        d = self.decl(name)
        if d is None or not d.as_type_declaration():
            return None
        v = self.value(el.text or "", d.declared_type())
        return self.f.create_entity(name, v)

    # ------------------------------------------------------------- passaggio 1: crea le entita'
    def create(self, el):
        """crea l'entita' dell'elemento (e delle annidate); restituisce l'entita' o None"""
        if "href" in el.attrib or "ref" in el.attrib:
            ref = el.attrib.get("href") or el.attrib.get("ref")
            return ("ref", ref)
        name = _local(el.attrib.get(XSI + "type", el.tag))
        if not self.is_entity(name):
            return None
        try:
            ent = self.f.create_entity(name)
        except Exception:  # noqa: BLE001 - entita' astratta o non creabile
            self.skipped += 1
            return None
        if "id" in el.attrib:
            self.ids[el.attrib["id"]] = ent
        direct, inverse = self.attrs(name)
        for k, v in el.attrib.items():
            if k in ("id",) or k.startswith(XSI) or k.startswith("{"):
                continue
            a = direct.get(k)
            if a is None:
                continue
            try:
                val = self.value(v, a.type_of_attribute())
                if val is not None:
                    setattr(ent, k, val)
            except Exception:  # noqa: BLE001
                self.skipped += 1
        for ch in el:
            an = _local(ch.tag)
            if an in direct:
                self.pending.append((ent, an, ch, direct[an]))
            elif an in inverse:
                ref = inverse[an].attribute_reference()
                agg = ref.type_of_attribute().as_aggregation_type() is not None
                for sub in ch:
                    child = self.create(sub)
                    if child is not None:
                        self.inv.append((child, ref.name(), ent, agg))
            else:
                self.skipped += 1
        return ent

    def resolve(self, x):
        if isinstance(x, tuple) and x and x[0] == "ref":
            return self.ids.get(x[1])
        return x

    def _item(self, el, t):
        """elemento dentro un attributo -> valore (entita', valore tipizzato, testo semplice)"""
        k, x = self._base(t)
        name = _local(el.attrib.get(XSI + "type", el.tag))
        if self.is_entity(name) or "href" in el.attrib or "ref" in el.attrib:
            return self.resolve(self.create(el))
        if k == "select":  # valore tipizzato dentro un select: <IfcLabel>x</IfcLabel>
            return self.typed(el)
        if k in ("simple", "enum", "typedecl"):  # elemento di una lista di valori: <IfcLengthMeasure>0.</IfcLengthMeasure>, <exp:double-wrapper>
            return self.value(el.text or "", t)
        return None

    # ------------------------------------------------------------- passaggio 2: attributi in elementi
    def fill(self):
        i = 0
        while i < len(self.pending):  # create() puo' aggiungere altre voci mentre si scorre
            ent, an, ch, a = self.pending[i]
            i += 1
            t = a.type_of_attribute()
            k, x = self._base(t)
            try:
                if ch.attrib.get(XSI + "type") or "href" in ch.attrib:  # l'elemento attributo e' esso stesso l'entita'
                    tv = self.typed(ch) if not self.is_entity(_local(ch.attrib.get(XSI + "type", ""))) else None
                    v = tv if tv is not None else self.resolve(self.create(ch))
                elif k == "agg":
                    kids = list(ch)
                    if kids:
                        v = [y for y in (self._item(e, x) for e in kids) if y is not None]
                    else:
                        v = self.value(ch.text or "", t)
                elif len(ch):
                    v = self._item(ch[0], t)
                else:
                    v = self.value(ch.text or "", t)
                if v is not None and v != []:
                    setattr(ent, an, v)
            except Exception:  # noqa: BLE001
                self.skipped += 1
        # riferimenti in avanti dentro le liste (href citati prima della definizione)
        for child, attr, parent, agg in self.inv:
            child = self.resolve(child)
            if child is None:
                continue
            try:
                if agg:
                    cur = list(getattr(child, attr) or [])
                    if parent not in cur:
                        setattr(child, attr, cur + [parent])
                else:
                    setattr(child, attr, parent)
            except Exception:  # noqa: BLE001
                self.skipped += 1


def to_ifc(path: str, update=lambda *a, **k: None) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}|{VERSION}".encode()).hexdigest()[:16]
    out = CACHE / f"{key}.ifc"
    if out.exists():
        return {"ok": True, "path": str(out), "cache": True}
    update(progress=0.1, message=tr("srv_ifcxml.lettura"))
    with open(path, "rb") as fh:
        head = fh.read(4000).decode("utf-8", "replace")
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        raise ValueError(tr("srv_ifcxml.xml_rotto", str(e))) from e
    if _local(root.tag).lower() not in ("ifcxml", "uos", "iso_10303_28"):
        raise ValueError(tr("srv_ifcxml.non_ifcxml"))
    C = Conv(_schema_of(root, head))
    tops = []
    for el in root:
        ln = _local(el.tag)
        if ln == "uos":  # forma ISO 10303-28 (ifcXML di IFC2x3): le entita' stanno nella "unita' di serializzazione"
            tops.extend(el)
        elif ln not in ("header", "iso_10303_28_header", "express", "schema_population"):
            tops.append(el)
    for el in tops:
        C.create(el)
    update(progress=0.6, message=tr("srv_ifcxml.collegamenti"))
    C.fill()
    tmp = out.with_suffix(".tmp")
    C.f.write(str(tmp))
    os.replace(tmp, out)
    return {"ok": True, "path": str(out), "entita": len(list(C.f)), "saltati": C.skipped}
