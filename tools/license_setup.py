"""Chiavi del sistema di licenze di MB Visual.

  python tools/license_setup.py chiavi      crea (una volta sola) la coppia di chiavi di firma e il codice di accesso
                                            dell'app di gestione in %USERPROFILE%\\.mbvisual\\licenze (FUORI da OneDrive)
                                            e scrive la chiave pubblica in mbvisual/license_pub.py
  python tools/license_setup.py server      prepara la copia di lavoro del server in %USERPROFILE%\\.mbvisual\\server
                                            (wrangler.toml con chiave pubblica, .dev.vars con i segreti per le prove locali)

La chiave PRIVATA firma le attivazioni: chi la possiede puo' creare licenze valide. Resta solo sul PC del proprietario
(e nei segreti del server). Va conservata anche una copia di sicurezza, per esempio in un gestore di password.
"""
import base64
import json
import secrets
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VAULT = Path.home() / ".mbvisual" / "licenze"
SERVER_WORK = Path.home() / ".mbvisual" / "server"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def keys() -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    VAULT.mkdir(parents=True, exist_ok=True)
    f = VAULT / "chiavi.json"
    if f.exists():
        data = json.loads(f.read_text(encoding="utf-8"))
        print("Chiavi gia' presenti (non rigenerate: le licenze emesse resterebbero senza firma valida):", f)
    else:
        sk = Ed25519PrivateKey.generate()
        data = {
            "private_pkcs8": b64u(sk.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())),
            "public_raw": b64u(sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)),
            "admin_token": secrets.token_urlsafe(32),
        }
        f.write_text(json.dumps(data, indent=1), encoding="utf-8")
        print("Create le chiavi in", f, "- FAI UNA COPIA DI SICUREZZA di questo file")
    (ROOT / "mbvisual" / "license_pub.py").write_text(
        '"""Chiave pubblica che verifica le attivazioni firmate dal server delle licenze (tools/license_setup.py)."""\n'
        f'PUBLIC_KEY = "{data["public_raw"]}"\n', encoding="utf-8")
    print("Chiave pubblica scritta in mbvisual/license_pub.py")


def server() -> None:
    data = json.loads((VAULT / "chiavi.json").read_text(encoding="utf-8"))
    src = ROOT / "server"
    SERVER_WORK.mkdir(parents=True, exist_ok=True)
    for p in src.rglob("*"):
        if p.is_file():
            d = SERVER_WORK / p.relative_to(src)
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, d)
    toml = (SERVER_WORK / "wrangler.toml").read_text(encoding="utf-8").replace("__PUBLIC_KEY__", data["public_raw"])
    db_id = (VAULT / "database_id.txt").read_text().strip() if (VAULT / "database_id.txt").exists() else "00000000-0000-0000-0000-000000000000"
    (SERVER_WORK / "wrangler.toml").write_text(toml.replace("__DATABASE_ID__", db_id), encoding="utf-8")
    (SERVER_WORK / ".dev.vars").write_text(f'SIGNING_KEY="{data["private_pkcs8"]}"\nADMIN_TOKEN="{data["admin_token"]}"\n', encoding="utf-8")
    print("Copia di lavoro del server pronta in", SERVER_WORK)


if __name__ == "__main__":
    {"chiavi": keys, "server": server}[sys.argv[1] if len(sys.argv) > 1 else "chiavi"]()
