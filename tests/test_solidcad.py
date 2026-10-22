"""Collaudo del lettore SolidWorks / Solid Edge / Parasolid (mbvisual/solidcad.py, parasolid.py, xt2step.py).

Prima: python tools/fetch_solidcad_samples.py   (file pubblici in %USERPROFILE%\\.mbvisual\\solidcad-campioni)
Uso:   python tests/test_solidcad.py [cartella]

Per ogni file: lettura di anteprima/proprieta'/componenti (passo 1) e conversione in STEP (passo 2), con le facce
convertite. Con --occt ogni STEP si rilegge anche con occt-import-js (lo stesso motore del visualizzatore; serve Node
e ui/vendor/occt). Riepilogo finale con percentuali.
"""
import glob
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from mbvisual import solidcad  # noqa: E402

EXTS = {"." + e for e in solidcad.SW_EXTS | solidcad.SE_EXTS | solidcad.XT_EXTS}
OCCT_JS = r"""
const path = require("path"), fs = require("fs");
const occt = require(path.join(process.argv[2], "ui/vendor/occt/dist/occt-import-js.js"));
occt().then(o => { for (const f of process.argv.slice(3)) {
  const r = o.ReadStepFile(new Uint8Array(fs.readFileSync(f)), { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.002, angularDeflection: 0.5 });
  let faces = 0, empty = 0; for (const m of r.meshes || []) for (const b of m.brep_faces || []) { faces++; if (b.last < b.first) empty++; }
  console.log(JSON.stringify({ f, ok: r.success, faces, empty }));
} });
"""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    folder = args[0] if args else os.path.join(os.path.expanduser("~"), ".mbvisual", "solidcad-campioni")
    files = sorted(f for f in glob.glob(os.path.join(folder, "**", "*"), recursive=True) if os.path.splitext(f)[1].lower() in EXTS)
    if not files:
        print("Nessun file: lanciare prima tools/fetch_solidcad_samples.py")
        return 1
    tot = {"file": 0, "info_ok": 0, "geo": 0, "step_ok": 0, "faces": 0, "faces_ok": 0, "solo_info": 0}
    steps, errors = [], []
    for f in files:
        tot["file"] += 1
        t0 = time.time()
        try:
            i = solidcad.info(f)
            tot["info_ok"] += 1
        except Exception as e:  # noqa: BLE001
            errors.append(f"INFO {os.path.basename(f)}: {e}")
            continue
        line = f"{os.path.basename(f)[-40:]:40} {i['cad'] or '-':3} prop={len(i['proprieta']):3} comp={len(i['componenti']):3} anteprima={'si' if i['anteprima'] else 'no'}"
        if i["geometria"]:
            tot["geo"] += 1
            try:
                r = solidcad.to_step(f)
                tot["step_ok"] += 1
                tot["faces"] += r["facce"]
                tot["faces_ok"] += r["convertite"]
                steps.append(r["step"])
                line += f" STEP {r['convertite']}/{r['facce']}"
                if r.get("mancanti"):
                    line += f" mancanti={len(r['mancanti'])}"
            except Exception as e:  # noqa: BLE001
                errors.append(f"STEP {os.path.basename(f)}: {e}")
                line += " STEP ERRORE"
        else:
            tot["solo_info"] += 1
        print(f"{line} {time.time() - t0:.1f}s", flush=True)
    print("\nRIEPILOGO", json.dumps(tot))
    if tot["faces"]:
        print(f"facce convertite: {100.0 * tot['faces_ok'] / tot['faces']:.2f}%  file con geometria convertiti: {tot['step_ok']}/{tot['geo']}")
    for e in errors:
        print("  ", e)
    if "--occt" in sys.argv and steps:
        js = os.path.join(solidcad.TEMP_DIR, "solidcad", "occt_check.js")
        open(js, "w", encoding="utf-8").write(OCCT_JS)
        out = subprocess.run(["node", js, ROOT, *steps], capture_output=True, text=True).stdout
        res = [json.loads(x) for x in out.splitlines() if x.startswith("{")]
        print(f"OpenCascade: {sum(1 for x in res if x['ok'])}/{len(res)} STEP letti, facce {sum(x['faces'] for x in res)}, "
              f"facce senza triangoli {sum(x['empty'] for x in res)}")
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
