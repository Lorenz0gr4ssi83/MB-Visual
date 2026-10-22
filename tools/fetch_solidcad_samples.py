"""Scarica i file di prova pubblici per il lettore SolidWorks / Solid Edge / Parasolid (tests/test_solidcad.py).

Fonti (repository GitHub pubblici, file usati SOLO per il collaudo, non distribuiti con l'app):
  AmboVent-1690-108/AmboVent            SolidWorks 2015+ (parti, assiemi annidati, tavole) + assieme esportato in x_t
  psas/sw-cad-airframe-rollcontrol      SolidWorks fino al 2014 (OLE) parti, assiemi, tavole, x_t (BSD-2-Clause)
  WangWen-Believer/Biped-Robot-project  SolidWorks 2010-2016 (OLE) parti/assiemi + x_t
  sbbxiii/The-Ostrich                   Solid Edge parti, assieme, tavola (Unlicense)
  nmg322/DFab16                         Solid Edge parti di versioni piu' vecchie (MIT)
  ocakiroglu/Solid-Edge-Practicing      Solid Edge parti e tavole (MIT)
  SolidEdgeCommunity/SEU14              tavole Solid Edge
  usnistgov/engineering-design-models   Parasolid V9 (testo)
  ansys/example-data, SCOREC/pumi-meshes, MaslowCNC/Mechanics, flexcompute/Flow360   Parasolid V10-V35 (testo)

Uso: python tools/fetch_solidcad_samples.py [cartella]   (predefinita: %USERPROFILE%\\.mbvisual\\solidcad-campioni)
Serve `gh` autenticato (elenco dei file); i file si scaricano da raw.githubusercontent.com con il nome originale.
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

SOURCES = [
    ("AmboVent-1690-108/AmboVent", r"Casing/.*[.](sldprt|sldasm|slddrw|x_t)$", 60),
    ("psas/sw-cad-airframe-rollcontrol", r"[.](sldprt|sldasm|slddrw|x_t)$", 40),
    ("WangWen-Believer/Biped-Robot-project", r"[Ss]olidworks/.*[.](sldprt|sldasm|x_t)$", 20),
    ("sbbxiii/The-Ostrich", r"[.](par|asm|dft)$", 40),
    ("nmg322/DFab16", r"[.](par|asm|dft|psm)$", 12),
    ("ocakiroglu/Solid-Edge-Practicing", r"[.](par|asm|psm)$|01-Exercise[.]dft", 20),
    ("SolidEdgeCommunity/SEU14", r"[.]dft$", 5),
    ("usnistgov/engineering-design-models", r"[.]x_t$", 10),
    ("MaslowCNC/Mechanics", r"[.]x_t$", 3),
    ("SCOREC/pumi-meshes", r"[.]x_t$", 6),
    ("ansys/example-data", r"[.](x_t|x_b)$", 12),
    ("flexcompute/Flow360", r"[.](x_t|x_b)$", 5),
]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.expanduser("~"), ".mbvisual", "solidcad-campioni")
    for repo, pat, limit in SOURCES:
        branch = subprocess.check_output(["gh", "api", f"repos/{repo}", "--jq", ".default_branch"]).decode().strip()
        tree = json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/git/trees/{branch}?recursive=1"]))
        dest_dir = os.path.join(out, repo.replace("/", "__"))
        os.makedirs(dest_dir, exist_ok=True)
        n = 0
        for t in tree["tree"]:
            if t["type"] != "blob" or not re.search(pat, t["path"], re.I) or t.get("size", 0) > 15_000_000:
                continue
            dest = os.path.join(dest_dir, t["path"].split("/")[-1])
            if not os.path.exists(dest):
                url = f"https://raw.githubusercontent.com/{repo}/{branch}/" + urllib.parse.quote(t["path"])
                try:
                    urllib.request.urlretrieve(url, dest)
                except Exception as e:  # noqa: BLE001
                    print("errore", url, e)
                    continue
            n += 1
            if n >= limit:
                break
        print(f"{repo}: {n} file")


if __name__ == "__main__":
    main()
