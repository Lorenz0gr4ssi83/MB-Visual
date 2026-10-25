"""Chiavi del sistema di licenze di MB Desk.

  python tools/license_setup.py chiavi      crea (una volta sola) la coppia di chiavi di firma e il codice di accesso
                                            dell'app di gestione in %USERPROFILE%\\.mbvisual\\licenze (FUORI da OneDrive)
                                            e scrive la chiave pubblica in mbvisual/license_pub.py
  python tools/license_setup.py server      prepara la copia di lavoro del server in %USERPROFILE%\\.mbvisual\\server
                                            (wrangler.toml con chiave pubblica, .dev.vars con i segreti per le prove locali)
  python tools/license_setup.py telefono    app per telefono di MB Desk Admin: crea (una volta sola) il percorso segreto
                                            dell'app e le chiavi VAPID delle notifiche in chiavi.json e li carica come
                                            segreti del Worker (ADMIN_PATH, VAPID_JWK) con wrangler

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
    url_file = VAULT / "server_url.txt"  # indirizzo del server, scritto dopo la messa online
    url = url_file.read_text().strip() if url_file.exists() else ""
    (ROOT / "mbvisual" / "license_pub.py").write_text(
        '"""Chiave pubblica che verifica le attivazioni firmate dal server delle licenze e indirizzo del server\n'
        '(scritti da tools/license_setup.py)."""\n'
        f'PUBLIC_KEY = "{data["public_raw"]}"\nLICENSE_URL = "{url}"\n', encoding="utf-8")
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


def telefono() -> None:
    import os
    import subprocess
    from cryptography.hazmat.primitives.asymmetric import ec
    f = VAULT / "chiavi.json"
    data = json.loads(f.read_text(encoding="utf-8"))
    if not data.get("admin_path"):
        data["admin_path"] = secrets.token_urlsafe(18)  # 24 caratteri: indirizzo non indovinabile
    if not data.get("vapid_jwk"):
        k = ec.generate_private_key(ec.SECP256R1())
        n = k.private_numbers()
        data["vapid_jwk"] = {"d": b64u(n.private_value.to_bytes(32, "big")), "x": b64u(n.public_numbers.x.to_bytes(32, "big")),
                             "y": b64u(n.public_numbers.y.to_bytes(32, "big"))}
    f.write_text(json.dumps(data, indent=1), encoding="utf-8")
    node = Path.home() / ".mbvisual" / "node-x64"  # wrangler non gira con Node per ARM64
    env = {**os.environ, "PATH": f"{node}{os.pathsep}{os.environ.get('PATH', '')}"}
    for name, value in (("ADMIN_PATH", data["admin_path"]), ("VAPID_JWK", json.dumps(data["vapid_jwk"]))):
        subprocess.run([str(node / "npx.cmd"), "wrangler", "secret", "put", name], input=value.encode(), cwd=SERVER_WORK, env=env, check=True)
    url = (VAULT / "server_url.txt").read_text().strip() if (VAULT / "server_url.txt").exists() else "<server>"
    print("App per telefono di MB Desk Admin:", f"{url}/{data['admin_path']}/", "(indirizzo da non diffondere)")


def segreti() -> None:
    """Carica TUTTI i segreti nel Worker di wrangler.toml (serve per un Worker nuovo, es. il cambio di nome in MB Desk)."""
    import os
    import subprocess
    data = json.loads((VAULT / "chiavi.json").read_text(encoding="utf-8"))
    node = Path.home() / ".mbvisual" / "node-x64"
    env = {**os.environ, "PATH": f"{node}{os.pathsep}{os.environ.get('PATH', '')}"}
    vals = [("SIGNING_KEY", data["private_pkcs8"]), ("ADMIN_TOKEN", data["admin_token"])]
    if data.get("admin_path"):
        vals += [("ADMIN_PATH", data["admin_path"]), ("VAPID_JWK", json.dumps(data["vapid_jwk"]))]
    for name, value in vals:
        subprocess.run([str(node / "npx.cmd"), "wrangler", "secret", "put", name], input=value.encode(), cwd=SERVER_WORK, env=env, check=True)
    print("Segreti caricati:", ", ".join(n for n, _ in vals))


if __name__ == "__main__":
    {"chiavi": keys, "server": server, "telefono": telefono, "segreti": segreti}[sys.argv[1] if len(sys.argv) > 1 else "chiavi"]()
