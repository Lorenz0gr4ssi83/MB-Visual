"""Collaudo dell'IFC con i soli dati delle famiglie Revit (mbvisual/fx_revit.py family_ifc).

    python tests/test_revit_ifc.py [cartella_con_altri_rfa]

- famiglia vera tests/samples/fx/pubblici/withModelText.rfa (DynamoRevit, Apache-2.0) + gli .rfa della cartella indicata;
- famiglia sintetica "Porte" con due tipi, misure in mm/ft, OmniClass e caratteri non ASCII;
- ogni IFC si riapre con web-ifc (tests/check_ifc_webifc.mjs, ui/vendor) e, se installato, si valida con IfcOpenShell
  (ifcopenshell.validate: SOLO per le prove, non fa parte dell'app).
"""
from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from mbvisual import fx_revit  # noqa: E402

ok = fail = 0


def check(cond, msg):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print("ERRORE:", msg)


SYNTH = {
    "versione": "2024",
    "famiglia": {
        "titolo": "Porta à battente", "categorie": ["Doors"], "omniclass": ["23.30.10.00"], "ospite": "Wall", "numero_tipi": "2",
        "parametri": [{"gruppo": "Construction", "nome": "Function", "valore": "Interior", "tipo": "", "origine": "system"},
                      {"gruppo": "Other", "nome": "Shared", "valore": "No", "tipo": "Yes/No", "origine": "system"}],
        "tipi": [{"nome": "800 x 2100 mm", "parametri": [{"nome": "Width", "valore": "800", "unita": "mm"},
                                                        {"nome": "Height", "valore": "7", "unita": "ft"},
                                                        {"nome": "Note", "valore": "l'anta è 'reversibile' \\ 50%", "unita": ""}]},
                 {"nome": "900 x 2100 mm", "parametri": [{"nome": "Width", "valore": "900", "unita": "mm"}]}],
    },
}


def main():
    out = tempfile.mkdtemp(prefix="mbv-revit-ifc-")
    files = []
    srcs = [os.path.join(ROOT, "tests/samples/fx/pubblici/withModelText.rfa")]
    if len(sys.argv) > 1:
        srcs += sorted(glob.glob(os.path.join(sys.argv[1], "*.rfa")))
    for src in srcs:
        dst = os.path.join(out, os.path.basename(src) + ".ifc")
        fx_revit.export(src, dst)
        files.append(dst)
    synth = os.path.join(out, "sintetica.ifc")
    with open(synth, "w", encoding="utf-8", newline="\n") as f:
        f.write(fx_revit.family_ifc(SYNTH, "C:/x/Porta.rfa"))
    files.append(synth)

    # progetto .rvt: niente IFC (non ci sono dati di famiglia)
    try:
        fx_revit.export(os.path.join(ROOT, "tests/samples/fx/pubblici/Empty-Metric.rvt"), os.path.join(out, "x.ifc"))
        check(False, "un .rvt non deve produrre l'IFC")
    except ValueError:
        check(True, "")

    check(fx_revit.ifc_class(["Doors"])[0] == "IFCDOORTYPE", "Doors -> IfcDoorType")
    check(fx_revit.ifc_class(["Arredi"])[0] == "IFCFURNITURETYPE", "Arredi -> IfcFurnitureType")
    check(fx_revit.ifc_class(["Generic Models"])[0] == "IFCBUILDINGELEMENTPROXYTYPE", "modelli generici -> proxy")
    check(len({fx_revit._ifc_guid() for _ in range(2000)}) == 2000, "GlobalId unici")
    check(all(c in "0123" for c in (fx_revit._ifc_guid()[0] for _ in range(200))), "primo carattere del GlobalId 0-3")

    node = subprocess.run(["node", os.path.join(ROOT, "tests/check_ifc_webifc.mjs"), *files], capture_output=True, text=True, encoding="utf-8")
    check(node.returncode == 0, "web-ifc: " + node.stderr[-500:])
    res = {r["file"]: r for r in json.loads(node.stdout or "[]")}
    for fpath in files:
        r = res.get(os.path.basename(fpath))
        check(r is not None, f"{fpath}: non letto da web-ifc")
        if not r:
            continue
        check(r["schema"] == "IFC4" and not r["errors"], f"{r['file']}: schema {r['schema']} errori {r['errors'][:3]}")
        check(len(r["types"]) >= 1 and len(r["elements"]) == len(r["types"]), f"{r['file']}: tipi/elementi {len(r['types'])}/{len(r['elements'])}")
        check(r["meshes"] == 0, f"{r['file']}: non deve avere geometria")
        print(f"{r['file']}: {r['lines']} righe, {[(t['cls'], t['name'], len(t['psets'])) for t in r['types']]}")
    s = res.get("sintetica.ifc")
    if s:
        check([t["cls"].upper() for t in s["types"]] == ["IFCDOORTYPE", "IFCDOORTYPE"], "sintetica: due IfcDoorType")
        check({e["cls"].upper() for e in s["elements"]} == {"IFCDOOR"}, "sintetica: occorrenze IfcDoor")
        check(s["project"] == "Porta à battente", "sintetica: nome con accento " + str(s.get("project")))
        check(s["classification"] == ["23.30.10.00"], "sintetica: OmniClass")
        t0 = {p["name"]: p["props"] for p in s["types"][0]["psets"]}
        tipo = next((v for k, v in t0.items() if "Width" in v), {})
        check(abs(tipo.get("Width", 0) - 0.8) < 1e-9, "sintetica: 800 mm -> 0,8 m " + str(tipo.get("Width")))
        check(abs(tipo.get("Height", 0) - 7 * 0.3048) < 1e-9, "sintetica: 7 ft in metri")
        check(tipo.get("Note") == "l'anta è 'reversibile' \\ 50%", "sintetica: testo con apostrofi " + repr(tipo.get("Note")))
        check(t0.get("Other", {}).get("Shared") is False, "sintetica: Si/No -> booleano")
        check(len(s["types"][1]["psets"]) == len(t0), "sintetica: property set ripetuti per il secondo tipo")

    try:
        import ifcopenshell
        import ifcopenshell.validate
    except ImportError:
        print("IfcOpenShell non installato: validazione dello schema saltata")
    else:
        for fpath in files:
            log = ifcopenshell.validate.json_logger()
            ifcopenshell.validate.validate(ifcopenshell.open(fpath), log, express_rules=True)
            check(not log.statements, f"{os.path.basename(fpath)}: IfcOpenShell {log.statements[:3]}")
        print("validazione IfcOpenShell", ifcopenshell.version)
    print(f"\n{ok} prove riuscite, {fail} fallite (IFC in {out})")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
