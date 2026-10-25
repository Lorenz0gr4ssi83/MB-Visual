"""Pubblica l'app per telefono (web app sul server delle licenze) della STESSA versione dell'app per PC.

Uso:  python tools/publish_web.py [commit]     (predefinito: il commit attuale del repository da cui si lancia)

Lo chiama da solo tools/build_portable.py quando pubblica una build in "App per PC" (salvo --no-web), cosi' i telefoni
si aggiornano insieme ai PC: all'apertura dell'app il service worker scarica i file nuovi e la pagina passa alla versione
nuova (ui/js/phone.js avvisa "Aggiornata alla versione X").
Passi: copia pulita %USERPROFILE%\\.mbvisual\\wt-web sullo stesso commit (git worktree, ui/vendor copiata dal progetto),
tools/license_setup.py server, tools/build_web.py --mobile (versione dell'app per PC in MBV_VERSIONE), wrangler deploy
con il Node x64 portatile (wrangler non gira con Node ARM64).
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = Path.home() / ".mbvisual"
WT = HOME / "wt-web"
SERVER = HOME / "server"
NODE = HOME / "node-x64"


def git(*args, cwd=ROOT) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # l'uscita di wrangler ha simboli che la console cp1252 non stampa
    commit = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else git("rev-parse", "HEAD")
    if not (HOME / "licenze" / "chiavi.json").exists():
        print("publish_web: mancano le chiavi del server (%USERPROFILE%\\.mbvisual\\licenze): app per telefono non pubblicata")
        return 1
    if not (NODE / "npx.cmd").exists():
        print("publish_web: manca Node x64 portatile in", NODE, "- app per telefono non pubblicata")
        return 1
    # copia pulita sullo stesso commit dell'app per PC (le modifiche non salvate del progetto non entrano)
    if not (WT / ".git").exists():
        subprocess.run(["git", "worktree", "add", "--detach", str(WT), commit], cwd=ROOT, check=True)
    else:
        subprocess.run(["git", "checkout", "-q", "--detach", "--force", commit], cwd=WT, check=True)
    vend_src, vend_dst = ROOT / "ui" / "vendor", WT / "ui" / "vendor"
    if vend_src.is_dir():  # ui/vendor e' in .gitignore: si allinea dal progetto
        sys.path.insert(0, str(ROOT / "tools"))
        from synctree import sync_tree
        print("ui/vendor:", sync_tree(vend_src, vend_dst))
    version = re.search(r'^VERSION = "([^"]+)"', (WT / "app.py").read_text(encoding="utf-8"), re.M).group(1)
    py = sys.executable
    env = {**os.environ, "MBV_VERSIONE": version}
    subprocess.run([py, "tools/license_setup.py", "server"], cwd=WT, check=True, env=env)
    subprocess.run([py, "tools/build_web.py", "--mobile"], cwd=WT, check=True, env=env)
    denv = {**env, "PATH": f"{NODE}{os.pathsep}{env.get('PATH', '')}"}
    r = subprocess.run([str(NODE / "npx.cmd"), "wrangler", "deploy"], cwd=SERVER, env=denv, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(r.stdout[-1500:], r.stderr[-800:])
    if r.returncode:
        print("publish_web: wrangler deploy non riuscito")
        return r.returncode
    # stesso codice anche sul Worker con il nome precedente ("mbvisual"): telefoni installati sul vecchio indirizzo,
    # stesso database e stessi segreti; senza cron (gli avvisi giornalieri li manda solo il Worker principale)
    toml = (SERVER / "wrangler.toml").read_text(encoding="utf-8")
    legacy = re.sub(r'(?m)^name = ".*"$', 'name = "mbvisual"', toml)
    legacy = re.sub(r"(?m)^crons = \[.*\]$", "crons = []", legacy)
    (SERVER / "wrangler.legacy.toml").write_text(legacy, encoding="utf-8")
    r2 = subprocess.run([str(NODE / "npx.cmd"), "wrangler", "deploy", "-c", "wrangler.legacy.toml"], cwd=SERVER, env=denv,
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("Worker con il nome precedente:", "aggiornato" if not r2.returncode else "NON aggiornato: " + r2.stderr[-800:])
    vid = re.search(r"Current Version ID: (\S+)", r.stdout)
    print(f"App per telefono {version} pubblicata (commit {commit[:7]}, versione del Worker {vid.group(1) if vid else '?'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
