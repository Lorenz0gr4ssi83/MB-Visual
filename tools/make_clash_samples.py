"""IFC di prova per le funzioni di Navisworks Manage (interferenze, computo): tests/samples/interferenze.

struttura.ifc  muri, pilastri, travi, solai su due piani, con tipi e Qto; interferenze volute:
               trave B2 dentro i muri W3 e W4 (0,15 m), pilastro C3 = copia esatta di C2 (duplicato)
impianti.ifc   tubi e canale nelle stesse coordinate (da federare con la struttura):
               tubo P1 attraversa i muri W3 e W4, canale D1 attraversa le travi B1 e B2,
               tubo P2 passa 3 cm sotto la trave B2 (distanza minima), tubo P3 lontano da tutto
Le attese del collaudo sono in tests/test_clash.mjs.
"""
import hashlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "tests" / "samples" / "interferenze"
B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"


def guid(seed: str) -> str:
    h = int(hashlib.sha1(seed.encode()).hexdigest(), 16)
    return "".join(B64[(h >> (6 * i)) & 63] for i in range(22))


class Ifc:
    def __init__(self, name):
        self.name = name
        self.L: list[str] = []
        self.n = 0
        self.dz = self.add("IFCDIRECTION((0.,0.,1.))")
        self.dx = self.add("IFCDIRECTION((1.,0.,0.))")
        self.dy = self.add("IFCDIRECTION((0.,1.,0.))")
        world = self.add(f"IFCAXIS2PLACEMENT3D(#{self.pt(0, 0, 0)},#{self.dz},#{self.dx})")
        ctx = self.add(f"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#{world},$)")
        self.body = self.add(f"IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#{ctx},$,.MODEL_VIEW.,$)")
        u = [self.add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)"), self.add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"),
             self.add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)")]
        units = self.add(f"IFCUNITASSIGNMENT(({','.join('#%d' % i for i in u)}))")
        self.proj = self.add(f"IFCPROJECT('{guid(name + 'proj')}',$,'Capannone {name}',$,$,$,$,(#{ctx}),#{units})")
        site_pl = self.placement(None, 0, 0, 0)
        site = self.add(f"IFCSITE('{guid(name + 'site')}',$,'Lotto',$,$,#{site_pl},$,$,.ELEMENT.,$,$,$,$,$)")
        bld_pl = self.placement(site_pl, 0, 0, 0)
        bld = self.add(f"IFCBUILDING('{guid(name + 'bld')}',$,'Edificio A',$,$,#{bld_pl},$,$,.ELEMENT.,$,$,$)")
        self.storeys = {}
        sts = []
        for key, label, z in (("PT", "Piano terra", 0.0), ("P1", "Piano primo", 4.0)):
            pl = self.placement(bld_pl, 0, 0, z)
            s = self.add(f"IFCBUILDINGSTOREY('{guid(name + key)}',$,'{label}',$,$,#{pl},$,$,.ELEMENT.,{z})")
            self.storeys[key] = {"id": s, "pl": pl, "z": z, "els": []}
            sts.append(s)
        self.add(f"IFCRELAGGREGATES('{guid(name + 'ag1')}',$,$,$,#{self.proj},(#{site}))")
        self.add(f"IFCRELAGGREGATES('{guid(name + 'ag2')}',$,$,$,#{site},(#{bld}))")
        self.add(f"IFCRELAGGREGATES('{guid(name + 'ag3')}',$,$,$,#{bld},({','.join('#%d' % s for s in sts)}))")
        self.types = {}

    def add(self, s: str) -> int:
        self.n += 1
        self.L.append(f"#{self.n}={s};")
        return self.n

    def pt(self, x, y, z=None):
        if z is None:
            return self.add(f"IFCCARTESIANPOINT(({x:.4f},{y:.4f}))")
        return self.add(f"IFCCARTESIANPOINT(({x:.4f},{y:.4f},{z:.4f}))")

    def placement(self, rel, x, y, z):
        ax = self.add(f"IFCAXIS2PLACEMENT3D(#{self.pt(x, y, z)},$,$)")
        return self.add(f"IFCLOCALPLACEMENT({'#%d' % rel if rel else '$'},#{ax})")

    def shape(self, solid):
        rep = self.add(f"IFCSHAPEREPRESENTATION(#{self.body},'Body','SweptSolid',(#{solid}))")
        return self.add(f"IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}))")

    def box(self, x0, y0, z0, x1, y1, z1):
        """parallelepipedo in coordinate del piano (z dal piano)"""
        p2 = self.add(f"IFCAXIS2PLACEMENT2D(#{self.pt(0, 0)},$)")
        prof = self.add(f"IFCRECTANGLEPROFILEDEF(.AREA.,$,#{p2},{x1 - x0:.4f},{y1 - y0:.4f})")
        ax = self.add(f"IFCAXIS2PLACEMENT3D(#{self.pt((x0 + x1) / 2, (y0 + y1) / 2, z0)},$,$)")
        return self.shape(self.add(f"IFCEXTRUDEDAREASOLID(#{prof},#{ax},#{self.dz},{z1 - z0:.4f})"))

    def sweep(self, x, y, z, axis, length, profile):
        """estrusione orizzontale lungo X o Y da (x, y, z); profile = ('C', raggio) o ('R', larghezza, altezza)"""
        p2 = self.add(f"IFCAXIS2PLACEMENT2D(#{self.pt(0, 0)},$)")
        if profile[0] == "C":
            prof = self.add(f"IFCCIRCLEPROFILEDEF(.AREA.,$,#{p2},{profile[1]:.4f})")
        else:
            prof = self.add(f"IFCRECTANGLEPROFILEDEF(.AREA.,$,#{p2},{profile[1]:.4f},{profile[2]:.4f})")
        # asse locale Z = direzione dell'estrusione; X locale orizzontale perpendicolare
        ax_dir, ref = (self.dx, self.dy) if axis == "x" else (self.dy, self.dx)
        ax = self.add(f"IFCAXIS2PLACEMENT3D(#{self.pt(x, y, z)},#{ax_dir},#{ref})")
        return self.shape(self.add(f"IFCEXTRUDEDAREASOLID(#{prof},#{ax},#{self.dz},{length:.4f})"))

    def element(self, cls, key, name, storey, shape, predef=".NOTDEFINED.", typ=None, qto=None, pset=None):
        st = self.storeys[storey]
        pl = self.placement(st["pl"], 0, 0, 0)
        e = self.add(f"{cls}('{guid(self.name + key)}',$,'{name}',$,$,#{pl},#{shape},'{key}',{predef})")
        st["els"].append(e)
        if typ:
            tcls, tname = typ
            if tname not in self.types:
                t = self.add(f"{tcls}('{guid(self.name + tname)}',$,'{tname}',$,$,$,$,$,$,.NOTDEFINED.)")
                self.types[tname] = (t, [])
            self.types[tname][1].append(e)
        if qto:
            qname, qs = qto
            ids = [self.add(f"IFCQUANTITY{kind}('{k}',$,$,{v:.4f},$)") for k, (kind, v) in qs.items()]
            q = self.add(f"IFCELEMENTQUANTITY('{guid(self.name + key + qname)}',$,'{qname}',$,$,({','.join('#%d' % i for i in ids)}))")
            self.add(f"IFCRELDEFINESBYPROPERTIES('{guid(self.name + key + 'q')}',$,$,$,(#{e}),#{q})")
        if pset:
            pname, props = pset
            ids = []
            for k, v in props.items():
                val = f"IFCLABEL('{v}')" if isinstance(v, str) else f"IFCLENGTHMEASURE({float(v)})"
                ids.append(self.add(f"IFCPROPERTYSINGLEVALUE('{k}',$,{val},$)"))
            ps = self.add(f"IFCPROPERTYSET('{guid(self.name + key + pname)}',$,'{pname}',$,({','.join('#%d' % i for i in ids)}))")
            self.add(f"IFCRELDEFINESBYPROPERTIES('{guid(self.name + key + 'p')}',$,$,$,(#{e}),#{ps})")
        return e

    def write(self, path: Path):
        for key, st in self.storeys.items():
            if st["els"]:
                self.add(f"IFCRELCONTAINEDINSPATIALSTRUCTURE('{guid(self.name + key + 'cont')}',$,$,$,({','.join('#%d' % e for e in st['els'])}),#{st['id']})")
        for tname, (t, els) in self.types.items():
            self.add(f"IFCRELDEFINESBYTYPE('{guid(self.name + tname + 'rt')}',$,$,$,({','.join('#%d' % e for e in els)}),#{t})")
        head = ("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\n"
                f"FILE_NAME('{path.name}','2026-10-22T10:00:00',('MB Desk'),('MB Group'),'','make_clash_samples','');\n"
                "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n")
        path.write_text(head + "\n".join(self.L) + "\nENDSEC;\nEND-ISO-10303-21;\n", encoding="utf-8")


def struttura(path: Path):
    f = Ifc("struttura")
    wall_t = ("IFCWALLTYPE", "Muro c.a. 30 cm")
    for key, (x0, y0, x1, y1) in {"W1": (0, 0, 12, 0.3), "W2": (0, 7.7, 12, 8), "W3": (0, 0.3, 0.3, 7.7), "W4": (11.7, 0.3, 12, 7.7)}.items():
        ln = max(x1 - x0, y1 - y0)
        f.element("IFCWALL", key, f"Muro {key}", "PT", f.box(x0, y0, 0, x1, y1, 4), ".STANDARD.", wall_t,
                  ("Qto_WallBaseQuantities", {"Length": ("LENGTH", ln), "Height": ("LENGTH", 4.0), "Width": ("LENGTH", 0.3),
                                              "NetSideArea": ("AREA", ln * 4.0), "NetVolume": ("VOLUME", ln * 0.3 * 4.0)}),
                  ("Pset_WallCommon", {"Reference": "Muro c.a. 30 cm"}))
    col_t = ("IFCCOLUMNTYPE", "Pilastro 40x40")
    for key, (x, y) in {"C1": (4, 4), "C2": (8, 4), "C3": (8, 4)}.items():  # C3 = copia esatta di C2
        f.element("IFCCOLUMN", key, f"Pilastro {key}", "PT", f.box(x - 0.2, y - 0.2, 0, x + 0.2, y + 0.2, 4), ".COLUMN.", col_t,
                  ("Qto_ColumnBaseQuantities", {"Length": ("LENGTH", 4.0), "NetVolume": ("VOLUME", 0.64)}))
    beam_t = ("IFCBEAMTYPE", "Trave 40x60")
    # B1 tra i pilastri (appoggiata, nessuna interferenza), B2 da muro a muro entrando 15 cm in W3 e W4
    for key, (x0, y0, x1, y1) in {"B1": (4.2, 3.8, 7.8, 4.2), "B2": (0.15, 1.8, 11.85, 2.2)}.items():
        ln = x1 - x0
        f.element("IFCBEAM", key, f"Trave {key}", "PT", f.box(x0, y0, 3.4, x1, y1, 4.0), ".BEAM.", beam_t,
                  ("Qto_BeamBaseQuantities", {"Length": ("LENGTH", ln), "NetVolume": ("VOLUME", ln * 0.24)}))
    slab_t = ("IFCSLABTYPE", "Solaio 25 cm")
    f.element("IFCSLAB", "S0", "Platea", "PT", f.box(0, 0, -0.3, 12, 8, 0), ".BASESLAB.", ("IFCSLABTYPE", "Platea 30 cm"),
              ("Qto_SlabBaseQuantities", {"Width": ("LENGTH", 0.3), "NetArea": ("AREA", 96.0), "NetVolume": ("VOLUME", 28.8)}))
    f.element("IFCSLAB", "S1", "Solaio piano primo", "P1", f.box(0, 0, 0, 12, 8, 0.25), ".FLOOR.", slab_t,
              ("Qto_SlabBaseQuantities", {"Width": ("LENGTH", 0.25), "NetArea": ("AREA", 96.0), "NetVolume": ("VOLUME", 24.0)}))
    f.write(path)


def impianti(path: Path):
    f = Ifc("impianti")
    pipe_t = ("IFCPIPESEGMENTTYPE", "Tubo DN100")
    pipes = {"P1": (-0.5, 5.0, 2.5, 13.0),   # attraversa W3 e W4
             "P2": (1.0, 2.0, 3.32, 10.0),   # 3 cm sotto la trave B2 (fondo trave a 3,40, tubo fino a 3,37)
             "P3": (1.0, 6.5, 1.0, 10.0)}    # lontano da tutto
    for key, (x, y, z, ln) in pipes.items():
        f.element("IFCPIPESEGMENT", key, f"Tubo {key}", "PT", f.sweep(x, y, z, "x", ln, ("C", 0.05)), ".RIGIDSEGMENT.", pipe_t,
                  ("Qto_PipeSegmentBaseQuantities", {"Length": ("LENGTH", ln)}))
    f.element("IFCDUCTSEGMENT", "D1", "Canale D1", "PT", f.sweep(6.0, 0.5, 3.65, "y", 7.0, ("R", 0.4, 0.3)), ".RIGIDSEGMENT.",
              ("IFCDUCTSEGMENTTYPE", "Canale 400x300"), ("Qto_DuctSegmentBaseQuantities", {"Length": ("LENGTH", 7.0)}))
    f.write(path)


def grande(path: Path, n: int):
    """prova di carico (non nel repository): griglia n x n di pilastri e travi + tubi che attraversano le travi"""
    f = Ifc("grande")
    for i in range(n):
        for j in range(n):
            x, y = i * 5.0, j * 5.0
            f.element("IFCCOLUMN", f"C{i}_{j}", f"Pilastro {i}-{j}", "PT", f.box(x, y, 0, x + 0.4, y + 0.4, 3.0), ".COLUMN.")
            f.element("IFCBEAM", f"B{i}_{j}", f"Trave {i}-{j}", "PT", f.box(x + 0.4, y, 2.4, x + 5.0, y + 0.4, 3.0), ".BEAM.")
    for k in range(n):
        f.element("IFCPIPESEGMENT", f"P{k}", f"Tubo {k}", "PT", f.sweep(k * 2.5 + 0.3 + 1.0, -1.0, 2.7, "y", n * 5.0 + 2, ("C", 0.08)), ".RIGIDSEGMENT.")
    f.write(path)


def main():
    import sys
    if len(sys.argv) > 2 and sys.argv[1] == "--grande":
        grande(Path(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 60)
        print(sys.argv[2], Path(sys.argv[2]).stat().st_size)
        return
    OUT.mkdir(parents=True, exist_ok=True)
    struttura(OUT / "struttura.ifc")
    impianti(OUT / "impianti.ifc")
    for p in sorted(OUT.iterdir()):
        print(p.name, p.stat().st_size)


if __name__ == "__main__":
    main()
