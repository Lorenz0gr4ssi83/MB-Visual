"""Crea i file GIS di prova in tests/samples/gis da dati pubblici e gratuiti.

Fonti (scaricate in %USERPROFILE%\\.mbvisual\\gisdati):
- Natural Earth (https://www.naturalearthdata.com) - pubblico dominio: confini degli Stati 1:110m, regioni 1:10m,
  centri abitati 1:10m, fiumi 1:10m.
- Copernicus DEM GLO-90 (tessera N45 E010, Lago di Garda), dal registro Open Data di AWS
  (https://registry.opendata.aws/copernicus-dem/). Licenza: uso libero anche commerciale con attribuzione
  "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the
  European Union and ESA; all rights reserved".

Le riproiezioni (Gauss-Boaga, RDN2008, ETRS89, WGS84 UTM) sono fatte con pyproj/PROJ, indipendente da proj4js
dell'app: i file servono anche a controllare la riproiezione del visualizzatore.
Uso (solo per rigenerare i campioni; non serve all'app):
    python -m venv %USERPROFILE%\\.mbvisual\\gisprova
    %USERPROFILE%\\.mbvisual\\gisprova\\Scripts\\pip install pyproj pyshp numpy pillow
    %USERPROFILE%\\.mbvisual\\gisprova\\Scripts\\python tools/make_gis_samples.py
"""
import io
import json
import sqlite3
import struct
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import shapefile  # pyshp (MIT)
from PIL import Image, TiffImagePlugin
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "samples" / "gis"
CACHE = Path.home() / ".mbvisual" / "gisdati"
NE = "https://naciscdn.org/naturalearth/"
SRC = {
    "ne_110m_admin_0_countries.zip": NE + "110m/cultural/ne_110m_admin_0_countries.zip",
    "ne_10m_admin_1_states_provinces.zip": NE + "10m/cultural/ne_10m_admin_1_states_provinces.zip",
    "ne_10m_populated_places_simple.zip": NE + "10m/cultural/ne_10m_populated_places_simple.zip",
    "ne_10m_rivers_lake_centerlines.zip": NE + "10m/physical/ne_10m_rivers_lake_centerlines.zip",
    "cop90_N45_E010.tif": "https://copernicus-dem-90m.s3.amazonaws.com/Copernicus_DSM_COG_30_N45_00_E010_00_DEM/Copernicus_DSM_COG_30_N45_00_E010_00_DEM.tif",
}
ATTR_COP = ("Copernicus DEM GLO-90: (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 "
            "provided under COPERNICUS by the European Union and ESA; all rights reserved")

# .prj in stile ESRI (come li scrivono ArcGIS e molti programmi italiani): verificano il riconoscimento per nome
PRJ_3003_ESRI = ('PROJCS["Monte_Mario_Italy_1",GEOGCS["GCS_Monte_Mario",DATUM["D_Monte_Mario",SPHEROID["International_1924",6378388.0,297.0]],'
                 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",1500000.0],'
                 'PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",9.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]')
WKT_6708 = ('PROJCS["RDN2008 / UTM zone 33N",GEOGCS["RDN2008",DATUM["Rete_Dinamica_Nazionale_2008",SPHEROID["GRS 1980",6378137,298.257222101]],'
            'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],'
            'PARAMETER["central_meridian",15],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],'
            'UNIT["metre",1],AUTHORITY["EPSG","6708"]]')


def get(name: str) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / name
    if not f.exists():
        print("scarico", SRC[name])
        req = urllib.request.Request(SRC[name], headers={"User-Agent": "mb-visual-samples"})
        with urllib.request.urlopen(req, timeout=300) as r:
            f.write_bytes(r.read())
    return f.read_bytes()


def reader(zname: str, base: str) -> shapefile.Reader:
    z = zipfile.ZipFile(io.BytesIO(get(zname)))
    part = lambda e: io.BytesIO(z.read(f"{base}.{e}"))
    return shapefile.Reader(shp=part("shp"), shx=part("shx"), dbf=part("dbf"), encoding="utf-8")


def tr(epsg_from: int, epsg_to: int):
    t = Transformer.from_crs(epsg_from, epsg_to, always_xy=True)
    return lambda pts: [tuple(round(v, 3) for v in t.transform(x, y)) for x, y in pts]


def italy_regions():
    r = reader("ne_10m_admin_1_states_provinces.zip", "ne_10m_admin_1_states_provinces")
    names = [f[0] for f in r.fields[1:]]
    out = []
    for sr in r.iterShapeRecords():
        rec = dict(zip(names, sr.record))
        if rec.get("adm0_a3") != "ITA":
            continue
        out.append((sr.shape, {"regione": rec["region"] or rec["name"], "nome": rec["name"], "codice": rec.get("iso_3166_2") or ""}))
    return out


def write_regions_3003(regions):
    t = tr(4326, 3003)
    w = shapefile.Writer(str(OUT / "province_gaussboaga"), shapeType=shapefile.POLYGON, encoding="cp1252")
    w.field("PROVINCIA", "C", 60)
    w.field("REGIONE", "C", 60)
    w.field("SIGLA", "C", 8)
    w.field("AREA_KMQ", "N", 12, 2)
    for shp, a in regions:
        parts = [t(shp.points[s:e]) for s, e in zip(shp.parts, list(shp.parts[1:]) + [len(shp.points)])]
        area = sum(abs(_ring_area(p)) for p in parts) / 1e6
        w.poly(parts)
        w.record(a["nome"], a["regione"], a["codice"].replace("IT-", ""), round(area, 2))
    w.close()
    (OUT / "province_gaussboaga.prj").write_text(PRJ_3003_ESRI, encoding="ascii")
    # niente .cpg: gli attributi con accenti in Windows-1252, come i vecchi shapefile italiani


def _ring_area(p):
    return sum(p[i - 1][0] * p[i][1] - p[i][0] * p[i - 1][1] for i in range(len(p))) / 2


def _wkb_polygon(rings):
    b = struct.pack("<BII", 1, 3, len(rings))
    for r in rings:
        b += struct.pack("<I", len(r)) + b"".join(struct.pack("<dd", x, y) for x, y in r)
    return b


def write_gpkg_6708(regions):
    p = OUT / "province_rdn2008_utm33.gpkg"
    p.unlink(missing_ok=True)
    t = tr(4326, 6708)
    con = sqlite3.connect(p)
    con.execute("PRAGMA application_id = 1196444487")
    con.execute("PRAGMA user_version = 10300")
    con.executescript("""
    CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);
    CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name));
    CREATE TABLE province (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom POLYGON, provincia TEXT, regione TEXT, sigla TEXT);
    """)
    con.executemany("INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)", [
        ("Undefined cartesian SRS", -1, "NONE", -1, "undefined", None),
        ("Undefined geographic SRS", 0, "NONE", 0, "undefined", None),
        ("WGS 84 geodetic", 4326, "EPSG", 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]', None),
        ("RDN2008 / UTM zone 33N", 6708, "EPSG", 6708, WKT_6708, None)])
    allx, ally = [], []
    for shp, a in regions:
        parts = [t(shp.points[s:e]) for s, e in zip(shp.parts, list(shp.parts[1:]) + [len(shp.points)])]
        # un poligono per anello esterno (le isole come righe distinte non servono: si tiene il piu' grande + buchi dentro)
        xs = [x for r in parts for x, _ in r]; ys = [y for r in parts for _, y in r]
        allx += [min(xs), max(xs)]; ally += [min(ys), max(ys)]
        env = struct.pack("<dddd", min(xs), max(xs), min(ys), max(ys))
        outer = max(parts, key=lambda r: abs(_ring_area(r)))
        blob = b"GP" + bytes([0, 0b00000011]) + struct.pack("<i", 6708) + env + _wkb_polygon([outer])
        con.execute("INSERT INTO province (geom, provincia, regione, sigla) VALUES (?,?,?,?)", (blob, a["nome"], a["regione"], a["codice"].replace("IT-", "")))
    con.execute("INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES ('province','features','Province (RDN2008 UTM 33N)',?,?,?,?,6708)",
                (min(allx), min(ally), max(allx), max(ally)))
    con.execute("INSERT INTO gpkg_geometry_columns VALUES ('province','geom','POLYGON',6708,0,0)")
    con.commit()
    con.close()


def places_italy():
    r = reader("ne_10m_populated_places_simple.zip", "ne_10m_populated_places_simple")
    names = [f[0] for f in r.fields[1:]]
    out = []
    for sr in r.iterShapeRecords():
        rec = dict(zip(names, sr.record))
        if rec.get("adm0_a3") == "ITA":
            out.append((sr.shape.points[0], {"nome": rec["name"], "regione": rec["adm1name"], "abitanti": int(rec["pop_max"] or 0),
                                              "capitale": bool(rec.get("adm0cap")), "rango": int(rec.get("scalerank") or 0)}))
    return out


def write_geojson_25832(places):
    t = tr(4326, 25832)
    feats = [{"type": "Feature", "properties": a, "geometry": {"type": "Point", "coordinates": list(t([pt])[0])}} for pt, a in places]
    gj = {"type": "FeatureCollection", "name": "centri_abitati_etrs89_utm32",
          "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}}, "features": feats}
    (OUT / "centri_abitati_etrs89_utm32.geojson").write_text(json.dumps(gj, ensure_ascii=False), encoding="utf-8")


def write_kml(places, regions):
    esc = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    pm = []
    for (x, y), a in places:
        if a["abitanti"] < 150000:
            continue
        pm.append(f'<Placemark><name>{esc(a["nome"])}</name><styleUrl>#citta</styleUrl><ExtendedData><Data name="regione"><value>{esc(a["regione"])}</value></Data>'
                  f'<Data name="abitanti"><value>{a["abitanti"]}</value></Data></ExtendedData><Point><coordinates>{x:.6f},{y:.6f}</coordinates></Point></Placemark>')
    kml = ('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Citta italiane oltre 150.000 abitanti</name>'
           '<Style id="citta"><IconStyle><color>ff2f8fd3</color><scale>1.1</scale><Icon><href>icona.png</href></Icon></IconStyle><LabelStyle><scale>0.9</scale></LabelStyle></Style>'
           + "".join(pm) + "</Document></kml>")
    (OUT / "citta_italiane.kml").write_text(kml.replace("<href>icona.png</href>", "<href>https://maps.google.com/mapfiles/kml/paddle/red-circle.png</href>"), encoding="utf-8")
    # KMZ: poligoni delle regioni del Nord con stile proprio + icona interna
    polys = []
    colors = ["7f2c6797", "7f2d7a46", "7f946400", "7f6b4fa0", "7fc0392b"]
    nord = {"Lombardia", "Piemonte", "Veneto", "Emilia-Romagna", "Liguria", "Trentino-Alto Adige", "Friuli-Venezia Giulia", "Valle d'Aosta"}
    styles = "".join(f'<Style id="s{i}"><LineStyle><color>ff333333</color><width>1.5</width></LineStyle><PolyStyle><color>{c}</color></PolyStyle></Style>' for i, c in enumerate(colors))
    for i, (shp, a) in enumerate((s, a) for s, a in regions if a["regione"] in nord):
        rings = [shp.points[s:e] for s, e in zip(shp.parts, list(shp.parts[1:]) + [len(shp.points)])]
        outer = max(rings, key=lambda r: abs(_ring_area(r)))
        coords = " ".join(f"{x:.5f},{y:.5f}" for x, y in outer)
        polys.append(f'<Placemark><name>{esc(a["nome"])}</name><description>{esc(a["regione"])}</description><styleUrl>#s{i % len(colors)}</styleUrl>'
                     f'<Polygon><outerBoundaryIs><LinearRing><coordinates>{coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>')
    doc = ('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Province del Nord Italia</name>'
           + styles + '<Style id="citta"><IconStyle><Icon><href>files/punto.png</href></Icon></IconStyle></Style>'
           + "".join(polys) + "".join(p for p in pm if any(r in p for r in nord)) + "</Document></kml>")
    icon = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    from PIL import ImageDraw
    ImageDraw.Draw(icon).ellipse((4, 4, 27, 27), fill=(211, 84, 0, 255), outline=(255, 255, 255, 255), width=3)
    b = io.BytesIO(); icon.save(b, "PNG")
    with zipfile.ZipFile(OUT / "province_nord.kmz", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", doc)
        z.writestr("files/punto.png", b.getvalue())


def write_gpx(places):
    r = reader("ne_10m_rivers_lake_centerlines.zip", "ne_10m_rivers_lake_centerlines")
    names = [f[0] for f in r.fields[1:]]
    segs = [sr.shape.points for sr in r.iterShapeRecords() if dict(zip(names, sr.record)).get("name") == "Po"]
    pts = "".join(f'<trkseg>{"".join(f"<trkpt lat=\"{y:.6f}\" lon=\"{x:.6f}\"/>" for x, y in s)}</trkseg>' for s in segs)
    wpt = "".join(f'<wpt lat="{y:.6f}" lon="{x:.6f}"><name>{a["nome"]}</name><desc>{a["regione"]}</desc></wpt>'
                  for (x, y), a in places if a["nome"] in ("Turin", "Torino", "Piacenza", "Cremona", "Ferrara", "Pavia"))
    gpx = ('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="MB Desk - dati Natural Earth" xmlns="http://www.topografix.com/GPX/1/1">'
           f'<metadata><name>Fiume Po (Natural Earth)</name></metadata>{wpt}<trk><name>Po</name>{pts}</trk></gpx>')
    (OUT / "fiume_po.gpx").write_text(gpx, encoding="utf-8")


def _geotiff(path: Path, img: Image.Image, tie, scale, keys, nodata=None, desc=""):
    ifd = TiffImagePlugin.ImageFileDirectory_v2()
    ifd[33550] = tuple(scale); ifd.tagtype[33550] = 12
    ifd[33922] = tuple(tie); ifd.tagtype[33922] = 12
    ifd[34735] = tuple(keys); ifd.tagtype[34735] = 3
    if nodata is not None:
        ifd[42113] = str(nodata); ifd.tagtype[42113] = 2
    ifd[270] = desc; ifd.tagtype[270] = 2
    img.save(path, "TIFF", tiffinfo=ifd, compression="tiff_deflate")


def write_dem():
    im = Image.open(io.BytesIO(get("cop90_N45_E010.tif")))
    a = np.array(im, dtype=np.float32)              # 1200x1200, 3" (~90 m), origine 10E 46N
    sub = a[::3, ::3]                              # 400x400 = 9" (~270 m)
    keys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
    _geotiff(OUT / "dem_garda_copernicus_wgs84.tif", Image.fromarray(sub, "F"), [0, 0, 0, 10.0, 46.0, 0], [1 / 400, 1 / 400, 0],
             keys, -32767, ATTR_COP)
    # rilievo ombreggiato a colori riproiettato in WGS 84 / UTM 32N (prova raster RGB in un sistema proiettato)
    t_inv = Transformer.from_crs(32632, 4326, always_xy=True)
    t_fwd = Transformer.from_crs(4326, 32632, always_xy=True)
    xs, ys = zip(*[t_fwd.transform(x, y) for x, y in [(10.4, 45.45), (11.0, 45.45), (10.4, 45.95), (11.0, 45.95)]])
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    W, H = 500, int(500 * (y1 - y0) / (x1 - x0))
    gx, gy = np.meshgrid(x0 + (np.arange(W) + .5) * (x1 - x0) / W, y1 - (np.arange(H) + .5) * (y1 - y0) / H)
    lon, lat = t_inv.transform(gx, gy)
    ci, ri = ((lon - 10.0) * 1200).astype(int).clip(0, 1199), ((46.0 - lat) * 1200).astype(int).clip(0, 1199)
    z = a[ri, ci]
    dzdx, dzdy = np.gradient(z, (x1 - x0) / W)
    hs = np.clip(0.6 + (-dzdx * 0.7 + dzdy * 0.7) / np.sqrt(1 + dzdx ** 2 + dzdy ** 2) * 0.9, 0, 1)
    tz = np.clip((z - 60) / 1800, 0, 1)
    base = np.stack([60 + tz * 170, 130 + tz * 70 - tz ** 2 * 60, 80 + tz * 100], -1)
    water = z < 70
    base[water] = [120, 170, 210]
    rgb = np.clip(base * hs[..., None] * 1.15, 0, 255).astype(np.uint8)
    keys = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32632]
    _geotiff(OUT / "rilievo_garda_utm32.tif", Image.fromarray(rgb, "RGB"), [0, 0, 0, x0, y1, 0], [(x1 - x0) / W, (y1 - y0) / H, 0], keys, None, ATTR_COP)


def write_countries_zip():
    z = zipfile.ZipFile(io.BytesIO(get("ne_110m_admin_0_countries.zip")))
    with zipfile.ZipFile(OUT / "paesi_naturalearth.zip", "w", zipfile.ZIP_DEFLATED) as o:
        for n in z.namelist():
            if n.rsplit(".", 1)[-1] in ("shp", "shx", "dbf", "prj", "cpg"):
                o.writestr("ne_110m_paesi/" + n, z.read(n))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    regions = italy_regions()
    places = places_italy()
    write_countries_zip()
    write_regions_3003(regions)
    write_gpkg_6708(regions)
    write_geojson_25832(places)
    write_kml(places, regions)
    write_gpx(places)
    write_dem()
    (OUT / "FONTI.md").write_text(__doc__.split("Le riproiezioni")[0].strip() + "\n\nFile creati da tools/make_gis_samples.py.\n", encoding="utf-8")
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:45s} {f.stat().st_size:>10,d}")


if __name__ == "__main__":
    main()
