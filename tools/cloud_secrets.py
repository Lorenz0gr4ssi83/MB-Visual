"""Scrive mbvisual/cloud_ids_build.py (escluso da git) con gli ID dei client OAuth registrati per MB Visual.

Fonte: variabile MBV_CLOUD_IDS (JSON, secret del workflow Mac) oppure %USERPROFILE%\\.mbvisual\\licenze\\cloud_ids.json,
nel formato di mbvisual/cloud_ids.py IDS, es. {"gdrive": {"client_id": "...", "client_secret": "..."}}.
Lo chiamano tools/build_portable.py e tools/build_mac.py; da solo: python tools/cloud_secrets.py [cartella_progetto].
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path.home() / ".mbvisual" / "licenze" / "cloud_ids.json"


def write(root: Path = ROOT) -> bool:
    raw = os.environ.get("MBV_CLOUD_IDS") or (SOURCE.read_text("utf-8") if SOURCE.exists() else "")
    if not raw.strip():
        print("ATTENZIONE: ID dei servizi cloud non trovati (", SOURCE, "o MBV_CLOUD_IDS ): Accedi con Google restera' nascosto")
        return False
    ids = json.loads(raw)
    (root / "mbvisual" / "cloud_ids_build.py").write_text(
        '"""Generato da tools/cloud_secrets.py durante la build: non modificare, non mettere in git."""\n'
        f"IDS = {json.dumps(ids, indent=1)}\n", encoding="utf-8")
    print("ID dei servizi cloud inclusi:", ", ".join(sorted(ids)))
    return True


if __name__ == "__main__":
    sys.exit(0 if write(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT) else 1)
